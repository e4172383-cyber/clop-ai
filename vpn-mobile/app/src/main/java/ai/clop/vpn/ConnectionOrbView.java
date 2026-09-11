package ai.clop.vpn;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

public final class ConnectionOrbView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path wave = new Path();
    private float phase;
    private boolean connected;
    private boolean connecting;
    private final ValueAnimator animator;

    public ConnectionOrbView(Context context) { this(context, null); }
    public ConnectionOrbView(Context context, AttributeSet attrs) {
        super(context, attrs);
        setClickable(true);
        setFocusable(true);
        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(2600);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(value -> { phase = (float) value.getAnimatedValue(); invalidate(); });
        animator.start();
    }

    public void setConnectionState(boolean isConnected, boolean isConnecting) {
        connected = isConnected;
        connecting = isConnecting;
        invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth(), h = getHeight(), cy = h * .48f;
        int accent = connected ? Color.rgb(63, 183, 132) : Color.rgb(241, 132, 82);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1.4f));
        paint.setColor(Color.argb(42, 101, 82, 70));
        for (int row = 0; row < 3; row++) {
            wave.reset();
            for (int x = 0; x <= w; x += 6) {
                float y = cy + (float) Math.sin((x / w * 6.1f) + phase * Math.PI * 2 + row) * dp(22 + row * 7) + (row - 1) * dp(17);
                if (x == 0) wave.moveTo(x, y); else wave.lineTo(x, y);
            }
            canvas.drawPath(wave, paint);
        }

        float pulse = (float) (.5 + .5 * Math.sin(phase * Math.PI * 2));
        float radius = dp(67 + (connected || connecting ? pulse * 11 : pulse * 3));
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(Color.argb(connected || connecting ? 36 : 18, Color.red(accent), Color.green(accent), Color.blue(accent)));
        canvas.drawCircle(w / 2, cy, radius, paint);
        paint.setColor(Color.argb(32, 255, 255, 255));
        canvas.drawCircle(w / 2, cy, dp(58), paint);
        paint.setShader(new RadialGradient(w / 2 - dp(16), cy - dp(18), dp(62), Color.rgb(255, 192, 150), accent, Shader.TileMode.CLAMP));
        canvas.drawCircle(w / 2, cy, dp(47), paint);
        paint.setShader(null);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(4));
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setColor(Color.WHITE);
        canvas.drawArc(w / 2 - dp(16), cy - dp(17), w / 2 + dp(16), cy + dp(17), -48, 276, false, paint);
        canvas.drawLine(w / 2, cy - dp(25), w / 2, cy - dp(2), paint);

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(accent);
        canvas.drawCircle(dp(38), cy + (float) Math.sin(phase * Math.PI * 2) * dp(18), dp(5), paint);
        canvas.drawCircle(w - dp(38), cy + (float) Math.cos(phase * Math.PI * 2) * dp(18), dp(5), paint);
    }

    private float dp(float value) { return value * getResources().getDisplayMetrics().density; }
}
