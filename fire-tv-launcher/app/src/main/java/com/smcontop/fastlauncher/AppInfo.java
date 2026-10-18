package com.smcontop.fastlauncher;

import android.content.ComponentName;

final class AppInfo {
    final String pkg;
    final ComponentName component;
    final String label;

    AppInfo(ComponentName component, String label) {
        this.pkg = component.getPackageName();
        this.component = component;
        this.label = label;
    }
}
