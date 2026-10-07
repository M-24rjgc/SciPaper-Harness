import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import com.android.zipflinger.BytesSource;
import com.android.zipflinger.ZipArchive;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Assembles and verifies an APK using the Android project's open-source packaging libraries. */
public final class AssembleApk {
    public static void main(String[] args) throws Exception {
        Path resources = Path.of(args[0]);
        Path dex = Path.of(args[1]);
        Path storePath = Path.of(args[2]);
        Path unsigned = Path.of(args[3]);
        Path output = Path.of(args[4]);
        char[] password = System.getenv("SCIPAPER_SIGNING_PASSWORD").toCharArray();
        Files.deleteIfExists(unsigned);
        try (ZipArchive target = new ZipArchive(unsigned); ZipFile input = new ZipFile(resources.toFile())) {
            var entries = input.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                try (InputStream stream = input.getInputStream(entry)) {
                    BytesSource source = new BytesSource(stream.readAllBytes(), entry.getName(), 0);
                    source.align(4);
                    target.add(source);
                }
            }
            BytesSource source = new BytesSource(Files.readAllBytes(dex), "classes.dex", 0);
            source.align(4);
            target.add(source);
        }
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream stream = Files.newInputStream(storePath)) { store.load(stream, password); }
        String alias = store.aliases().nextElement();
        var signer = new ApkSigner.SignerConfig.Builder("SciPaper",
                (PrivateKey) store.getKey(alias, password),
                List.of((X509Certificate) store.getCertificate(alias))).build();
        new ApkSigner.Builder(List.of(signer)).setInputApk(unsigned.toFile()).setOutputApk(output.toFile())
                .setMinSdkVersion(29).setV1SigningEnabled(false).setV2SigningEnabled(true)
                .setV3SigningEnabled(true).setV4SigningEnabled(false).build().sign();
        ApkVerifier.Result verification = new ApkVerifier.Builder(output.toFile())
                .setMinCheckedPlatformVersion(29).build().verify();
        if (!verification.isVerified()) throw new IllegalStateException("APK signature verification failed: " + verification.getErrors());
        System.out.println("APK signature verified: v2=" + verification.isVerifiedUsingV2Scheme()
                + ", v3=" + verification.isVerifiedUsingV3Scheme());
        System.out.println(output);
    }
}
