package com.marioherrera.mitiempo;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Mi Tiempo: abre la app web publicada a pantalla completa. Al cargar siempre la versión publicada,
 * la app se actualiza sola; el service worker de la web permite usarla sin conexión.
 */
public class MainActivity extends Activity {
    private static final String APP_URL = "https://marioherrera97.github.io/mi-tiempo/";
    private static final String APP_HOST = "marioherrera97.github.io";
    private static final int REQ_LOCATION = 1;

    private WebView web;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingOrigin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#11161d"));
        w.setNavigationBarColor(Color.parseColor("#11161d"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#11161d"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100); // el diseño ya está pensado para móvil
        s.setUserAgentString(s.getUserAgentString() + " MiTiempoApp/1");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (APP_HOST.equals(uri.getHost())) return false;
                // Enlaces externos (fuentes de datos, etc.) en el navegador
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (hasLocation()) {
                    cb.invoke(origin, true, false);
                } else {
                    pendingGeo = cb;
                    pendingOrigin = origin;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
                }
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(APP_URL);
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_LOCATION && pendingGeo != null) {
            pendingGeo.invoke(pendingOrigin, hasLocation(), false);
            pendingGeo = null;
        }
    }

    private void showOffline() {
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='background:#11161d;color:#e9eef5;font-family:sans-serif;display:flex;flex-direction:column;"
                + "align-items:center;justify-content:center;height:90vh;text-align:center;padding:20px'>"
                + "<h2>Sin conexión</h2><p style='color:#a5b1c2'>La primera vez Mi Tiempo necesita internet. Después funciona también sin conexión con los últimos datos.</p>"
                + "<button onclick=\"location.href='" + APP_URL + "'\" style='margin-top:16px;padding:12px 22px;border:0;border-radius:10px;"
                + "background:#4fa3ff;color:#fff;font-size:16px'>Reintentar</button></body></html>";
        web.loadDataWithBaseURL(APP_URL, html, "text/html", "utf-8", APP_URL);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }
}
