package ai.clop.vpn;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.TrafficStats;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.wireguard.android.backend.GoBackend;
import com.wireguard.android.backend.Tunnel;
import com.wireguard.config.Config;
import com.wireguard.crypto.KeyPair;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int VPN_PERMISSION = 701;
    private static final int INK = Color.rgb(46, 39, 34);
    private static final int MUTED = Color.rgb(142, 128, 118);
    private static final int ACCENT = Color.rgb(241, 132, 82);
    private static final int GREEN = Color.rgb(63, 183, 132);

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private SharedPreferences prefs;
    private GoBackend backend;
    private Config pendingConfig;
    private String token = "";
    private KeyPair keys;
    private ApiClient.Login pendingLogin;
    private boolean connected;
    private boolean connecting;
    private long lastRx, lastTx, lastTrafficAt;

    private TextView accountName, planText, connectionTitle, connectionSubtitle, downSpeed, upSpeed, trafficText, quotaText, locationTitle;
    private Button accountButton;
    private ProgressBar quotaBar;
    private ConnectionOrbView orb;

    private final Tunnel tunnel = new Tunnel() {
        @Override public String getName() { return "ClopVPN"; }
        @Override public void onStateChange(State state) {
            ui.post(() -> applyTunnelState(state == State.UP, false));
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("clop_vpn", MODE_PRIVATE);
        token = prefs.getString("token", "");
        backend = new GoBackend(getApplicationContext());
        loadKeys();
        buildInterface();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 702);
        }
        refreshAccount();
        io.execute(() -> {
            try { Tunnel.State stateNow = backend.getState(tunnel); ui.post(() -> applyTunnelState(stateNow == Tunnel.State.UP, false)); }
            catch (Exception ignored) {}
        });
        ui.post(trafficTicker);
    }

    private void buildInterface() {
        getWindow().setStatusBarColor(Color.rgb(248, 245, 241));
        getWindow().setNavigationBarColor(Color.rgb(248, 245, 241));
        if (Build.VERSION.SDK_INT >= 23) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(248, 245, 241));
        LinearLayout root = column();
        root.setPadding(dp(22), dp(20), dp(22), dp(32));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));

        LinearLayout header = row();
        TextView mark = text("C", 18, Color.WHITE, true);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(round(ACCENT, 15, 0, 0));
        header.addView(mark, lp(dp(46), dp(46), 0));
        LinearLayout brand = column();
        brand.setPadding(dp(12), 0, 0, 0);
        brand.addView(text("Clop VPN", 20, INK, true));
        brand.addView(text("MOBILE BETA", 10, MUTED, true));
        header.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
        TextView secure = pill("WIREGUARD", Color.rgb(112, 94, 82), Color.WHITE);
        header.addView(secure);
        root.addView(header);

        LinearLayout account = row();
        account.setGravity(Gravity.CENTER_VERTICAL);
        account.setPadding(dp(15), dp(13), dp(12), dp(13));
        account.setBackground(glass(18));
        LinearLayout accountCopy = column();
        accountName = text(token.isEmpty() ? "Войдите в Clop" : "Загрузка аккаунта…", 14, INK, true);
        planText = text("Единый аккаунт через Telegram", 11, MUTED, false);
        accountCopy.addView(accountName); accountCopy.addView(planText);
        account.addView(accountCopy, new LinearLayout.LayoutParams(0, -2, 1));
        accountButton = smallButton(token.isEmpty() ? "Войти" : "Профиль");
        accountButton.setOnClickListener(v -> { if (token.isEmpty()) beginLogin(); else showAccountDialog(); });
        account.addView(accountButton);
        LinearLayout.LayoutParams accountLp = matchWrap(); accountLp.setMargins(0, dp(24), 0, dp(15));
        root.addView(account, accountLp);

        TextView overline = text("ЗАЩИЩЁННОЕ СОЕДИНЕНИЕ", 10, MUTED, true);
        overline.setLetterSpacing(.12f);
        root.addView(overline);
        connectionTitle = text("Готов к подключению", 27, INK, true);
        connectionTitle.setPadding(0, dp(3), 0, dp(15));
        root.addView(connectionTitle);

        FrameLayout hero = new FrameLayout(this);
        hero.setBackground(glass(26));
        hero.setPadding(dp(5), 0, dp(5), dp(4));
        orb = new ConnectionOrbView(this);
        hero.addView(orb, new FrameLayout.LayoutParams(-1, dp(285)));
        LinearLayout heroCopy = column();
        heroCopy.setGravity(Gravity.CENTER);
        connectionSubtitle = text("Нажмите, чтобы подключиться", 14, INK, true);
        TextView locationSmall = text("Германия · Фалькенштайн", 11, MUTED, false);
        heroCopy.addView(connectionSubtitle); heroCopy.addView(locationSmall);
        FrameLayout.LayoutParams copyLp = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        copyLp.setMargins(dp(10), 0, dp(10), dp(21));
        hero.addView(heroCopy, copyLp);
        orb.setOnClickListener(v -> toggleConnection());
        root.addView(hero, matchWrap());

        LinearLayout location = row();
        location.setGravity(Gravity.CENTER_VERTICAL);
        location.setPadding(dp(15), dp(14), dp(15), dp(14));
        location.setBackground(glass(18));
        TextView flag = pill("DE", Color.rgb(45, 39, 35), Color.WHITE);
        location.addView(flag);
        LinearLayout locationCopy = column(); locationCopy.setPadding(dp(12), 0, 0, 0);
        locationTitle = text("Германия", 14, INK, true);
        locationCopy.addView(locationTitle); locationCopy.addView(text("Фалькенштайн · оптимальный маршрут", 11, MUTED, false));
        location.addView(locationCopy, new LinearLayout.LayoutParams(0, -2, 1));
        location.addView(text("Изменить  ›", 12, ACCENT, true));
        location.setOnClickListener(v -> showLocations());
        LinearLayout.LayoutParams locationLp = matchWrap(); locationLp.setMargins(0, dp(13), 0, dp(13));
        root.addView(location, locationLp);

        LinearLayout stats = row(); stats.setGravity(Gravity.CENTER); stats.setPadding(dp(8), dp(16), dp(8), dp(16)); stats.setBackground(glass(20));
        downSpeed = stat(stats, "СКАЧИВАНИЕ", "0.0 Мбит/с");
        View divider = new View(this); divider.setBackgroundColor(Color.rgb(230, 222, 215)); stats.addView(divider, lp(dp(1), dp(48), 0));
        upSpeed = stat(stats, "ОТПРАВКА", "0.0 Мбит/с");
        root.addView(stats, matchWrap());

        LinearLayout usage = column(); usage.setPadding(dp(16), dp(15), dp(16), dp(16)); usage.setBackground(glass(20));
        LinearLayout usageHead = row();
        usageHead.addView(text("Трафик за неделю", 13, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        trafficText = text("0 Б", 12, INK, true); usageHead.addView(trafficText);
        usage.addView(usageHead);
        quotaText = text("Лимит загружается…", 11, MUTED, false); quotaText.setPadding(0, dp(5), 0, dp(9)); usage.addView(quotaText);
        quotaBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); quotaBar.setMax(1000); quotaBar.setProgress(0); quotaBar.setProgressTintList(android.content.res.ColorStateList.valueOf(ACCENT)); quotaBar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(234, 227, 221)));
        usage.addView(quotaBar, lp(-1, dp(7), 0));
        LinearLayout.LayoutParams usageLp = matchWrap(); usageLp.setMargins(0, dp(13), 0, 0); root.addView(usage, usageLp);

        TextView note = text("Clop VPN шифрует соединение на устройстве. Ключ создаётся и хранится только на телефоне.", 11, MUTED, false);
        note.setGravity(Gravity.CENTER); note.setPadding(dp(12), dp(18), dp(12), 0); root.addView(note);
        setContentView(scroll);
    }

    private TextView stat(LinearLayout parent, String label, String value) {
        LinearLayout box = column(); box.setGravity(Gravity.CENTER);
        TextView v = text(value, 17, INK, true); TextView l = text(label, 9, MUTED, true); l.setLetterSpacing(.08f);
        box.addView(v); box.addView(l); parent.addView(box, new LinearLayout.LayoutParams(0, -2, 1)); return v;
    }

    private void beginLogin() {
        setBusy("Открываю Telegram…");
        io.execute(() -> {
            try {
                pendingLogin = ApiClient.beginLogin();
                Uri uri = Uri.parse("https://t.me/" + pendingLogin.bot() + "?start=desk_" + pendingLogin.code());
                ui.post(() -> {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    Toast.makeText(this, "Подтвердите вход в Telegram", Toast.LENGTH_LONG).show();
                    pollLogin();
                });
            } catch (Exception error) { showError(error); }
        });
    }

    private void pollLogin() {
        if (pendingLogin == null || System.currentTimeMillis() >= pendingLogin.expiresAt()) { pendingLogin = null; setBusy(null); return; }
        io.execute(() -> {
            try {
                JSONObject result = ApiClient.poll(pendingLogin);
                String newToken = result.optString("token", "");
                if (!newToken.isEmpty()) {
                    token = newToken; pendingLogin = null;
                    prefs.edit().putString("token", token).apply();
                    ui.post(() -> { setBusy(null); Toast.makeText(this, "Вход выполнен", Toast.LENGTH_SHORT).show(); refreshAccount(); });
                } else ui.postDelayed(this::pollLogin, 1800);
            } catch (Exception error) { ui.postDelayed(this::pollLogin, 2200); }
        });
    }

    private void refreshAccount() {
        if (token.isEmpty()) { accountName.setText("Войдите в Clop"); planText.setText("Единый аккаунт через Telegram"); accountButton.setText("Войти"); return; }
        io.execute(() -> {
            try {
                JSONObject me = ApiClient.me(token);
                JSONObject info = ApiClient.vpnInfo(token);
                String name = me.optString("name", "Clop"); String plan = me.optString("plan", "Бесплатный");
                JSONObject policy = info.optJSONObject("plan");
                ui.post(() -> { accountName.setText(name); planText.setText("Тариф " + plan); accountButton.setText("Профиль"); if (policy != null) quotaText.setText(policy.optInt("weeklyGb") + " ГБ в неделю · до " + policy.optInt("speedMbps") + " Мбит/с"); });
                refreshStatus();
            } catch (Exception error) {
                if (error.getMessage() != null && error.getMessage().contains("вход")) logout(); else showError(error);
            }
        });
    }

    private void toggleConnection() {
        if (connecting) return;
        if (token.isEmpty()) { beginLogin(); return; }
        if (connected) { disconnect(); return; }
        Intent permission = VpnService.prepare(this);
        if (permission != null) startActivityForResult(permission, VPN_PERMISSION); else connectNow();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == VPN_PERMISSION && resultCode == RESULT_OK) connectNow();
    }

    private void connectNow() {
        applyTunnelState(false, true);
        io.execute(() -> {
            try {
                JSONObject profile = ApiClient.createProfile(token, keys.getPublicKey().toBase64());
                pendingConfig = Config.parse(new ByteArrayInputStream(configText(profile).getBytes(StandardCharsets.UTF_8)));
                backend.setState(tunnel, Tunnel.State.UP, pendingConfig);
                ui.post(() -> { applyTunnelState(true, false); refreshStatus(); });
            } catch (Exception error) { ui.post(() -> applyTunnelState(false, false)); showError(error); }
        });
    }

    private void disconnect() {
        applyTunnelState(true, true);
        io.execute(() -> {
            try { backend.setState(tunnel, Tunnel.State.DOWN, null); ui.post(() -> applyTunnelState(false, false)); }
            catch (Exception error) { ui.post(() -> applyTunnelState(connected, false)); showError(error); }
        });
    }

    private String configText(JSONObject p) {
        JSONArray dns = p.optJSONArray("dns");
        String dnsLine = dns == null ? "1.1.1.1, 1.0.0.1" : dns.optString(0, "1.1.1.1") + ", " + dns.optString(1, "1.0.0.1");
        return "[Interface]\nPrivateKey = " + keys.getPrivateKey().toBase64() + "\nAddress = " + p.optString("address") + "\nDNS = " + dnsLine
                + "\n\n[Peer]\nPublicKey = " + p.optString("serverPublicKey") + "\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = " + p.optString("endpoint") + "\nPersistentKeepalive = 25\n";
    }

    private void applyTunnelState(boolean isConnected, boolean isConnecting) {
        connected = isConnected; connecting = isConnecting; orb.setConnectionState(connected, connecting);
        connectionTitle.setText(connecting ? (connected ? "Отключаю…" : "Защищаю соединение…") : connected ? "Соединение защищено" : "Готов к подключению");
        connectionSubtitle.setText(connecting ? "Настраиваю безопасный туннель" : connected ? "Нажмите, чтобы отключиться" : "Нажмите, чтобы подключиться");
        lastRx = TrafficStats.getTotalRxBytes(); lastTx = TrafficStats.getTotalTxBytes(); lastTrafficAt = System.currentTimeMillis();
    }

    private final Runnable trafficTicker = new Runnable() {
        @Override public void run() {
            long now = System.currentTimeMillis(), rx = TrafficStats.getTotalRxBytes(), tx = TrafficStats.getTotalTxBytes();
            long elapsed = Math.max(1, now - lastTrafficAt);
            if (connected && lastTrafficAt > 0) {
                downSpeed.setText(speed(Math.max(0, rx - lastRx), elapsed));
                upSpeed.setText(speed(Math.max(0, tx - lastTx), elapsed));
            } else { downSpeed.setText("0.0 Мбит/с"); upSpeed.setText("0.0 Мбит/с"); }
            lastRx = rx; lastTx = tx; lastTrafficAt = now;
            if (connected && now % 15000 < 1200) refreshStatus();
            ui.postDelayed(this, 1000);
        }
    };

    private void refreshStatus() {
        if (token.isEmpty()) return;
        io.execute(() -> {
            try {
                JSONObject p = ApiClient.vpnStatus(token);
                long used = p.optLong("usedBytes", 0), remaining = p.optLong("remainingBytes", 0);
                int progress = (int) Math.round(p.optDouble("usagePercent", 0) * 10);
                JSONObject policy = p.optJSONObject("plan");
                ui.post(() -> { trafficText.setText(bytes(used)); quotaBar.setProgress(progress); if (policy != null) quotaText.setText(bytes(remaining) + " осталось · до " + policy.optInt("speedMbps") + " Мбит/с"); });
            } catch (Exception ignored) {}
        });
    }

    private void showLocations() {
        Dialog dialog = new Dialog(this); dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout content = column(); content.setPadding(dp(22), dp(22), dp(22), dp(22)); content.setBackground(round(Color.rgb(253, 251, 248), 26, 1, Color.rgb(230, 220, 211)));
        content.addView(text("Выберите локацию", 23, INK, true));
        TextView hint = text("Маршрут переключится без повторного входа", 12, MUTED, false); hint.setPadding(0, dp(4), 0, dp(16)); content.addView(hint);
        addLocation(content, dialog, "DE", "Германия", "Фалькенштайн · 24 мс", true, 0);
        addLocation(content, dialog, "NL", "Нидерланды", "Скоро", false, 90);
        addLocation(content, dialog, "FR", "Франция", "Скоро", false, 180);
        addLocation(content, dialog, "US", "США", "Скоро", false, 270);
        dialog.setContentView(content); Window window = dialog.getWindow(); if (window != null) { window.setBackgroundDrawableResource(android.R.color.transparent); window.setLayout(-1, -2); window.setGravity(Gravity.BOTTOM); }
        dialog.setOnShowListener(x -> { Window w = dialog.getWindow(); if (w != null) w.setLayout(-1, -2); }); dialog.show();
    }

    private void addLocation(LinearLayout parent, Dialog dialog, String code, String title, String sub, boolean available, long delay) {
        LinearLayout item = row(); item.setGravity(Gravity.CENTER_VERTICAL); item.setPadding(dp(14), dp(13), dp(14), dp(13)); item.setBackground(round(available ? Color.WHITE : Color.rgb(247,244,241), 17, 1, Color.rgb(232,224,218)));
        item.addView(pill(code, available ? ACCENT : Color.rgb(184,173,165), Color.WHITE));
        LinearLayout copy = column(); copy.setPadding(dp(12),0,0,0); copy.addView(text(title,14,INK,true)); copy.addView(text(sub,11,MUTED,false)); item.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
        item.addView(text(available ? "Выбрано ✓" : "Скоро", 11, available ? GREEN : MUTED, true));
        LinearLayout.LayoutParams lp=matchWrap(); lp.setMargins(0,0,0,dp(9)); parent.addView(item,lp);
        item.setAlpha(0); item.setTranslationY(dp(22)); item.animate().alpha(1).translationY(0).setStartDelay(delay).setDuration(360).start();
        if (available) item.setOnClickListener(v -> { locationTitle.setText(title); item.animate().scaleX(.97f).scaleY(.97f).setDuration(90).withEndAction(dialog::dismiss).start(); });
    }

    private void showAccountDialog() {
        Dialog d = new Dialog(this); LinearLayout box = column(); box.setPadding(dp(24),dp(22),dp(24),dp(22)); box.setBackground(round(Color.WHITE,24,1,Color.rgb(230,220,211)));
        box.addView(text(accountName.getText().toString(),20,INK,true)); box.addView(text(planText.getText().toString(),12,MUTED,false));
        Button logout = smallButton("Выйти из аккаунта"); logout.setOnClickListener(v -> { d.dismiss(); logout(); }); LinearLayout.LayoutParams lp=matchWrap(); lp.setMargins(0,dp(18),0,0); box.addView(logout,lp);
        d.setContentView(box); d.show(); Window w=d.getWindow(); if(w!=null){w.setBackgroundDrawableResource(android.R.color.transparent);w.setLayout((int)(getResources().getDisplayMetrics().widthPixels*.88),-2);}
    }

    private void logout() { if (connected) disconnect(); token=""; prefs.edit().remove("token").apply(); refreshAccount(); }
    private void loadKeys() { try { String privateKey=prefs.getString("private_key",""); keys=privateKey.isEmpty()?new KeyPair():new KeyPair(com.wireguard.crypto.Key.fromBase64(privateKey)); if(privateKey.isEmpty()) prefs.edit().putString("private_key",keys.getPrivateKey().toBase64()).apply(); } catch(Exception e){ keys=new KeyPair(); prefs.edit().putString("private_key",keys.getPrivateKey().toBase64()).apply(); } }
    private void setBusy(String message) { accountButton.setEnabled(message==null); if(message!=null) accountButton.setText("Подождите…"); else accountButton.setText(token.isEmpty()?"Войти":"Профиль"); }
    private void showError(Exception error) { ui.post(() -> { setBusy(null); Toast.makeText(this, error.getMessage()==null?"Ошибка соединения":error.getMessage(), Toast.LENGTH_LONG).show(); }); }
    private String speed(long bytes,long ms){return String.format(Locale.US,"%.1f Мбит/с",bytes*8.0/ms/1000.0);} private String bytes(long n){if(n>=1_000_000_000L)return String.format(Locale.US,"%.1f ГБ",n/1e9);if(n>=1_000_000)return String.format(Locale.US,"%.1f МБ",n/1e6);if(n>=1000)return String.format(Locale.US,"%.1f КБ",n/1e3);return n+" Б";}
    private LinearLayout column(){LinearLayout v=new LinearLayout(this);v.setOrientation(LinearLayout.VERTICAL);return v;} private LinearLayout row(){LinearLayout v=new LinearLayout(this);v.setOrientation(LinearLayout.HORIZONTAL);return v;}
    private TextView text(String value,float sp,int color,boolean bold){TextView v=new TextView(this);v.setText(value);v.setTextSize(sp);v.setTextColor(color);v.setTypeface(Typeface.create("sans",bold?Typeface.BOLD:Typeface.NORMAL));v.setIncludeFontPadding(false);v.setLineSpacing(0,1.1f);return v;}
    private TextView pill(String value,int bg,int fg){TextView v=text(value,10,fg,true);v.setGravity(Gravity.CENTER);v.setPadding(dp(11),dp(7),dp(11),dp(7));v.setBackground(round(bg,99,0,0));return v;}
    private Button smallButton(String value){Button b=new Button(this);b.setText(value);b.setTextSize(11);b.setTextColor(Color.WHITE);b.setAllCaps(false);b.setTypeface(Typeface.DEFAULT,Typeface.BOLD);b.setPadding(dp(13),0,dp(13),0);b.setMinHeight(0);b.setMinimumHeight(0);b.setBackground(round(INK,13,0,0));return b;}
    private GradientDrawable glass(int radius){return round(Color.argb(205,255,255,255),radius,1,Color.rgb(231,223,216));} private GradientDrawable round(int color,int radius,int stroke,int strokeColor){GradientDrawable g=new GradientDrawable();g.setColor(color);g.setCornerRadius(dp(radius));if(stroke>0)g.setStroke(dp(stroke),strokeColor);return g;}
    private LinearLayout.LayoutParams lp(int w,int h,float weight){return new LinearLayout.LayoutParams(w,h,weight);} private LinearLayout.LayoutParams matchWrap(){return new LinearLayout.LayoutParams(-1,-2);} private int dp(float value){return Math.round(value*getResources().getDisplayMetrics().density);}

    @Override protected void onDestroy() { ui.removeCallbacksAndMessages(null); io.shutdown(); super.onDestroy(); }
}
