package com.smcontop.fastlauncher;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Favorites, hidden apps and Home-button settings. */
final class Prefs {
    private static final String FILE = "launcher";
    private static final String FAVORITES = "favorites";
    private static final String HIDDEN = "hidden";
    private static final String SEEDED = "seeded";
    private static final String OVERRIDE_HOME = "override_home";
    private static final String BYPASS = "bypass";

    /** Popular streaming apps pinned on first run, if installed. */
    private static final String[] DEFAULT_FAVORITES = {
            "com.netflix.ninja",
            "com.amazon.firetv.youtube",
            "com.google.android.youtube.tv",
            "com.amazon.avod",
            "com.disney.disneyplus",
            "com.hulu.plus",
            "com.wbd.stream",
            "com.plexapp.android",
            "org.xbmc.kodi",
    };

    private final SharedPreferences sp;

    Prefs(Context context) {
        sp = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    List<String> favorites() {
        String raw = sp.getString(FAVORITES, "");
        return raw.isEmpty() ? new ArrayList<>() : new ArrayList<>(Arrays.asList(raw.split(",")));
    }

    void setFavorites(List<String> packages) {
        sp.edit().putString(FAVORITES, TextUtils.join(",", packages)).apply();
    }

    /** On first run, pin whichever default streaming apps are installed. */
    void seedFavorites(Set<String> installed) {
        if (sp.getBoolean(SEEDED, false)) return;
        List<String> favs = new ArrayList<>();
        for (String pkg : DEFAULT_FAVORITES) {
            if (installed.contains(pkg)) favs.add(pkg);
        }
        sp.edit().putString(FAVORITES, TextUtils.join(",", favs)).putBoolean(SEEDED, true).apply();
    }

    Set<String> hidden() {
        return new HashSet<>(sp.getStringSet(HIDDEN, new HashSet<>()));
    }

    void setHidden(Set<String> packages) {
        sp.edit().putStringSet(HIDDEN, new HashSet<>(packages)).apply();
    }

    void resetLayout() {
        sp.edit().remove(FAVORITES).remove(HIDDEN).remove(SEEDED).apply();
    }

    /** Whether the Home button should open this launcher (when the service is enabled). */
    boolean overrideHome() {
        return sp.getBoolean(OVERRIDE_HOME, true);
    }

    void setOverrideHome(boolean value) {
        sp.edit().putBoolean(OVERRIDE_HOME, value).apply();
    }

    /**
     * Set when the user deliberately opens the Amazon home screen, so the Home
     * button leaves them there until they come back to this launcher.
     */
    boolean bypass() {
        return sp.getBoolean(BYPASS, false);
    }

    void setBypass(boolean value) {
        if (bypass() != value) sp.edit().putBoolean(BYPASS, value).apply();
    }
}
