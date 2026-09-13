package ai.clop.vpn;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "ai.clop.vpn.local-secrets.v1";
    private static final String PREFIX = "keystore:v1:";
    private final SharedPreferences preferences;

    SecureStore(Context context) {
        preferences = context.getSharedPreferences("clop_vpn", Context.MODE_PRIVATE);
    }

    synchronized String get(String name) {
        String stored = preferences.getString(name, "");
        if (stored == null || stored.isEmpty()) return "";
        if (!stored.startsWith(PREFIX)) {
            put(name, stored);
            return stored;
        }
        try {
            byte[] packed = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
            if (packed.length <= 12) throw new IllegalStateException("Encrypted value is incomplete");
            byte[] iv = new byte[12];
            byte[] encrypted = new byte[packed.length - iv.length];
            System.arraycopy(packed, 0, iv, 0, iv.length);
            System.arraycopy(packed, iv.length, encrypted, 0, encrypted.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception error) {
            preferences.edit().remove(name).apply();
            return "";
        }
    }

    synchronized void put(String name, String value) {
        if (value == null || value.isEmpty()) {
            remove(name);
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] packed = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, packed, 0, iv.length);
            System.arraycopy(encrypted, 0, packed, iv.length, encrypted.length);
            preferences.edit().putString(name, PREFIX + Base64.encodeToString(packed, Base64.NO_WRAP)).apply();
        } catch (Exception error) {
            throw new IllegalStateException("Не удалось защитить локальные данные Clop VPN.", error);
        }
    }

    synchronized void remove(String name) {
        preferences.edit().remove(name).apply();
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        java.security.Key existing = store.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey secretKey) return secretKey;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
