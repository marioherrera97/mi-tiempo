package com.marioherrera.mitiempo;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Widget de la pantalla de inicio: temperatura y cielo de ahora, máxima y mínima, cuándo llueve en las próximas
 * horas y las 5 horas siguientes, del lugar elegido en la app (lo guarda la web con MiTiempoAndroid.setPlace).
 * Se actualiza cada 30 minutos (el mínimo de Android), al abrir la app y al cambiar de lugar.
 */
public class WeatherWidget extends AppWidgetProvider {
    static final String PREFS = "widget";
    private static final int[][] HOURS = {
        {R.id.h0_time, R.id.h0_icon, R.id.h0_temp}, {R.id.h1_time, R.id.h1_icon, R.id.h1_temp},
        {R.id.h2_time, R.id.h2_icon, R.id.h2_temp}, {R.id.h3_time, R.id.h3_icon, R.id.h3_temp},
        {R.id.h4_time, R.id.h4_icon, R.id.h4_temp},
    };

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        final PendingResult pending = goAsync();
        final Context app = ctx.getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try { refresh(app, mgr, ids); } finally { pending.finish(); }
            }
        }).start();
    }

    /** Pide a los widgets que se actualicen ya (al cambiar de lugar en la app). */
    static void updateAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, WeatherWidget.class));
        if (ids.length == 0) return;
        Intent i = new Intent(ctx, WeatherWidget.class);
        i.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        i.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        ctx.sendBroadcast(i);
    }

    private static void refresh(Context ctx, AppWidgetManager mgr, int[] ids) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        Intent open = new Intent(ctx, MainActivity.class);
        v.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        String name = p.getString("name", null);
        if (name == null) {
            v.setTextViewText(R.id.w_place, "Mi Tiempo");
            v.setTextViewText(R.id.w_rain, "Abre la app para elegir el lugar");
            mgr.updateAppWidget(ids, v);
            return;
        }
        boolean fahr = "f".equals(p.getString("temp", "c"));
        v.setTextViewText(R.id.w_place, name);
        try {
            String url = String.format(Locale.US, "https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f"
                + "&current=temperature_2m,apparent_temperature,weather_code,is_day&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day"
                + "&daily=temperature_2m_max,temperature_2m_min&forecast_days=2&timezone=auto%s",
                p.getFloat("lat", 0), p.getFloat("lon", 0), fahr ? "&temperature_unit=fahrenheit" : "");
            JSONObject d = new JSONObject(get(url));
            JSONObject cur = d.getJSONObject("current");
            int code = cur.getInt("weather_code");
            boolean day = cur.optInt("is_day", 1) == 1;
            v.setTextViewText(R.id.w_temp, Math.round(cur.getDouble("temperature_2m")) + "°");
            v.setTextViewText(R.id.w_icon, icon(code, day));
            v.setTextViewText(R.id.w_desc, desc(code) + " · sensación " + Math.round(cur.getDouble("apparent_temperature")) + "°");
            JSONObject dd = d.getJSONObject("daily");
            v.setTextViewText(R.id.w_maxmin, "↑" + Math.round(dd.getJSONArray("temperature_2m_max").getDouble(0)) + "°  ↓"
                + Math.round(dd.getJSONArray("temperature_2m_min").getDouble(0)) + "°");

            JSONObject h = d.getJSONObject("hourly");
            JSONArray time = h.getJSONArray("time");
            String now = cur.getString("time").substring(0, 13);
            int i0 = 0;
            for (int i = 0; i < time.length(); i++) if (time.getString(i).startsWith(now)) { i0 = i; break; }
            for (int k = 0; k < HOURS.length; k++) {
                int i = i0 + 1 + k;
                if (i >= time.length()) break;
                v.setTextViewText(HOURS[k][0], time.getString(i).substring(11, 13) + "h");
                v.setTextViewText(HOURS[k][1], icon(h.getJSONArray("weather_code").getInt(i), h.getJSONArray("is_day").optInt(i, 1) == 1));
                v.setTextViewText(HOURS[k][2], Math.round(h.getJSONArray("temperature_2m").getDouble(i)) + "°");
            }
            v.setTextViewText(R.id.w_rain, rainLine(h, i0));
            v.setTextViewText(R.id.w_updated, new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date()));
        } catch (Exception e) {
            v.setTextViewText(R.id.w_rain, "Sin conexión · se reintentará");
        }
        mgr.updateAppWidget(ids, v);
    }

    /** «Lluvia hacia las 17h (70 %)» o «Sin lluvia en 12 h». */
    private static String rainLine(JSONObject h, int i0) throws Exception {
        JSONArray pr = h.getJSONArray("precipitation"), pp = h.getJSONArray("precipitation_probability"), t = h.getJSONArray("time");
        for (int i = i0; i < Math.min(t.length(), i0 + 12); i++) {
            double mm = pr.optDouble(i, 0);
            int prob = pp.optInt(i, 0);
            if (mm >= 0.2 && prob >= 30) {
                String when = i == i0 ? "Lloviendo o a punto de llover" : "Lluvia hacia las " + t.getString(i).substring(11, 13) + "h";
                return when + " (" + prob + " %)";
            }
        }
        return "Sin lluvia en las próximas 12 h";
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setRequestProperty("User-Agent", "MiTiempoWidget/1");
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    // Códigos WMO de Open-Meteo
    private static String icon(int c, boolean day) {
        if (c == 0) return day ? "☀️" : "🌙";
        if (c <= 2) return day ? "⛅" : "☁️";
        if (c == 3) return "☁️";
        if (c == 45 || c == 48) return "🌫️";
        if (c >= 95) return "⛈️";
        if ((c >= 71 && c <= 77) || c == 85 || c == 86) return "🌨️";
        if (c >= 51) return "🌧️";
        return "☁️";
    }

    private static String desc(int c) {
        if (c == 0) return "Despejado";
        if (c == 1) return "Casi despejado";
        if (c == 2) return "Nubes y claros";
        if (c == 3) return "Cubierto";
        if (c == 45 || c == 48) return "Niebla";
        if (c >= 51 && c <= 57) return "Llovizna";
        if (c >= 61 && c <= 67) return c == 65 ? "Lluvia fuerte" : "Lluvia";
        if (c >= 71 && c <= 77) return "Nieve";
        if (c >= 80 && c <= 82) return "Chubascos";
        if (c == 85 || c == 86) return "Chubascos de nieve";
        if (c >= 95) return "Tormenta";
        return "";
    }
}
