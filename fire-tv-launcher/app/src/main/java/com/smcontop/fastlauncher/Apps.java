package com.smcontop.fastlauncher;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.util.LruCache;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Loads installed apps and their artwork. */
final class Apps {
    /** Artwork for a tile: a 16:9 TV banner when the app has one, otherwise its icon. */
    static final class Art {
        final Drawable drawable;
        final boolean isBanner;
        /** A vivid colour sampled from the artwork, for the ambient glow. */
        final int color;

        Art(Drawable drawable, boolean isBanner) {
            this.drawable = drawable;
            this.isBanner = isBanner;
            this.color = vividColor(drawable);
        }
    }

    private static final LruCache<String, Art> ART = new LruCache<>(200);

    private Apps() {}

    /** All launchable apps (TV apps first, then phone-style apps), sorted by name. */
    static List<AppInfo> load(Context context) {
        PackageManager pm = context.getPackageManager();
        Map<String, AppInfo> byPkg = new LinkedHashMap<>();
        addAll(context, pm, Intent.CATEGORY_LEANBACK_LAUNCHER, byPkg);
        addAll(context, pm, Intent.CATEGORY_LAUNCHER, byPkg);
        List<AppInfo> apps = new ArrayList<>(byPkg.values());
        Collections.sort(apps, (a, b) -> a.label.compareToIgnoreCase(b.label));
        return apps;
    }

    private static void addAll(Context context, PackageManager pm, String category, Map<String, AppInfo> out) {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(category);
        for (ResolveInfo ri : pm.queryIntentActivities(intent, 0)) {
            ActivityInfo ai = ri.activityInfo;
            if (ai.packageName.equals(context.getPackageName()) || out.containsKey(ai.packageName)) continue;
            String label = String.valueOf(ri.loadLabel(pm)).trim();
            out.put(ai.packageName, new AppInfo(new ComponentName(ai.packageName, ai.name), label));
        }
    }

    /** Artwork if it has already been loaded, otherwise null. */
    static Art cachedArt(String pkg) {
        return ART.get(pkg);
    }

    /** Loads (and caches) a tile's artwork. Safe to call off the main thread. */
    static Art art(Context context, AppInfo app) {
        Art cached = ART.get(app.pkg);
        if (cached != null) return cached;
        PackageManager pm = context.getPackageManager();
        Drawable d = null;
        boolean banner = false;
        try {
            d = pm.getActivityBanner(app.component);
            if (d == null) d = pm.getApplicationBanner(app.pkg);
            banner = d != null;
            if (d == null) d = pm.getActivityIcon(app.component);
        } catch (PackageManager.NameNotFoundException ignored) {
            d = pm.getDefaultActivityIcon();
        }
        Art art = new Art(d, banner);
        ART.put(app.pkg, art);
        return art;
    }

    /**
     * Picks the most saturated, not-too-dark pixel from a 12x12 thumbnail; falls back to the
     * lifted average for near-monochrome art. Adapted from tv-vibehack by Gathin23 (MIT).
     */
    private static int vividColor(Drawable live) {
        if (live == null) return 0xFF444444;
        // Draw a private copy so the tile's own drawable keeps its bounds.
        Drawable d = live.getConstantState() != null ? live.getConstantState().newDrawable().mutate() : live;
        int n = 12;
        Bitmap bmp = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888);
        d.setBounds(0, 0, n, n);
        d.draw(new Canvas(bmp));
        float[] hsv = new float[3];
        int best = 0xFF444444;
        float bestScore = -1f;
        long r = 0, g = 0, b = 0;
        for (int y = 0; y < n; y++) {
            for (int x = 0; x < n; x++) {
                int p = bmp.getPixel(x, y);
                r += Color.red(p);
                g += Color.green(p);
                b += Color.blue(p);
                Color.colorToHSV(p, hsv);
                float score = hsv[1] * Math.min(1f, hsv[2] * 1.4f);
                if (score > bestScore) {
                    bestScore = score;
                    best = p;
                }
            }
        }
        bmp.recycle();
        if (bestScore < 0.25f) {
            Color.colorToHSV(Color.rgb((int) (r / (n * n)), (int) (g / (n * n)), (int) (b / (n * n))), hsv);
            hsv[2] = Math.max(hsv[2], 0.55f);
            return Color.HSVToColor(hsv);
        }
        Color.colorToHSV(best, hsv);
        hsv[1] = Math.min(1f, hsv[1] * 1.1f);
        hsv[2] = Math.max(0.5f, hsv[2]);
        return Color.HSVToColor(hsv);
    }

    static void forget(String pkg) {
        ART.remove(pkg);
    }

    static Intent launchIntent(AppInfo app) {
        return new Intent(Intent.ACTION_MAIN)
                .setComponent(app.component)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
    }
}
