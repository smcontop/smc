package com.smcontop.fastlauncher;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.text.TextUtils;

import java.util.LinkedHashSet;
import java.util.Set;

/** Finding the original (Amazon) home screen and the Home-button service state. */
final class Launchers {
    static final String AMAZON_LAUNCHER = "com.amazon.tv.launcher";

    private Launchers() {}

    /** Packages of every other home screen on the device, Amazon's first. */
    static Set<String> stockLaunchers(Context context) {
        Set<String> pkgs = new LinkedHashSet<>();
        pkgs.add(AMAZON_LAUNCHER);
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        for (ResolveInfo ri : context.getPackageManager().queryIntentActivities(home, 0)) {
            String pkg = ri.activityInfo.packageName;
            // Skip ourselves and Android's "pick a home app" fallback.
            if (!pkg.equals(context.getPackageName()) && !pkg.equals("com.android.settings")) pkgs.add(pkg);
        }
        return pkgs;
    }

    /** Opens the original home screen and keeps the Home button there until the user returns. */
    static boolean openStockHome(Context context) {
        new Prefs(context).setBypass(true);
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        for (ResolveInfo ri : context.getPackageManager().queryIntentActivities(home, 0)) {
            String pkg = ri.activityInfo.packageName;
            if (pkg.equals(context.getPackageName()) || pkg.equals("com.android.settings")) continue;
            Intent intent = new Intent(home)
                    .setComponent(new ComponentName(pkg, ri.activityInfo.name))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tryStart(context, intent)) return true;
        }
        Intent fallback = context.getPackageManager().getLaunchIntentForPackage(AMAZON_LAUNCHER);
        if (fallback != null && tryStart(context, fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) return true;
        new Prefs(context).setBypass(false);
        return false;
    }

    static boolean tryStart(Context context, Intent intent) {
        try {
            context.startActivity(intent);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    static boolean isServiceEnabled(Context context) {
        String enabled = Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        ComponentName ours = new ComponentName(context, HomeButtonService.class);
        for (String s : enabled.split(":")) {
            if (ours.equals(ComponentName.unflattenFromString(s))) return true;
        }
        return false;
    }

    static Intent showLauncher(Context context) {
        return new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
    }
}
