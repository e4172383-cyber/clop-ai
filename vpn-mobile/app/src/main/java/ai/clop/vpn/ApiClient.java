package ai.clop.vpn;

import android.util.Base64;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

final class ApiClient {
    static final String BASE = "https://clop.195-201-169-74.sslip.io";
    private static final SecureRandom RANDOM = new SecureRandom();

    record Login(String code, String secret, String bot, long expiresAt) {}

    static Login beginLogin() throws Exception {
        byte[] codeBytes = new byte[8];
        byte[] secretBytes = new byte[32];
        RANDOM.nextBytes(codeBytes);
        RANDOM.nextBytes(secretBytes);
        StringBuilder hex = new StringBuilder();
        for (byte value : codeBytes) hex.append(String.format("%02x", value & 0xff));
        String code = hex.toString();
        String secret = Base64.encodeToString(secretBytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8));
        String hash = Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        JSONObject body = new JSONObject().put("code", code).put("secretHash", hash).put("device", "Android · Clop VPN 1.0 Beta");
        JSONObject result = request("/desk/init", "POST", body, null);
        String bot = result.optString("bot", "").replace("@", "");
        if (bot.isBlank()) throw new Exception("Сервер не вернул Telegram-бота.");
        return new Login(code, secret, bot, System.currentTimeMillis() + 10 * 60_000L);
    }

    static JSONObject poll(Login login) throws Exception {
        return request("/desk/poll", "POST", new JSONObject().put("code", login.code()).put("secret", login.secret()), null);
    }

    static JSONObject me(String token) throws Exception { return request("/desk/me", "GET", null, token); }
    static JSONObject vpnInfo(String token) throws Exception { return request("/desk/vpn/info", "GET", null, token); }
    static JSONObject vpnStatus(String token) throws Exception { return request("/desk/vpn/status", "GET", null, token); }
    static JSONObject createProfile(String token, String publicKey) throws Exception {
        return request("/desk/vpn/profile", "POST", new JSONObject().put("publicKey", publicKey), token);
    }

    static JSONObject request(String path, String method, JSONObject body, String token) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(20_000);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null && !token.isBlank()) connection.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        StringBuilder raw = new StringBuilder();
        if (stream != null) try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) raw.append(line);
        }
        JSONObject json = raw.length() == 0 ? new JSONObject() : new JSONObject(raw.toString());
        if (status < 200 || status >= 300 || !json.optBoolean("ok", true)) {
            throw new Exception(json.optString("error", "Сервер вернул ошибку " + status));
        }
        return json;
    }
}
