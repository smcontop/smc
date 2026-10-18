package com.smcontop.fastlauncher;

import android.accessibilityservice.AccessibilityService;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.Set;

/**
 * Fire OS always sends the Home button to Amazon's launcher. This accessibility
 * service catches the Home key (and, as a fallback, the Amazon home screen
 * appearing) and opens Fast Launcher instead.
 */
public class HomeButtonService extends AccessibilityService {
    private static final long DEBOUNCE_MS = 700;
    private static final long LONG_PRESS_MS = 800;

    private Prefs prefs;
    private Set<String> stockLaunchers;
    private long lastLaunch;

    @Override
    protected void onServiceConnected() {
        prefs = new Prefs(this);
        stockLaunchers = Launchers.stockLaunchers(this);
        // Covers boot: the Amazon home screen is already showing when we connect.
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null && root.getPackageName() != null
                && stockLaunchers.contains(root.getPackageName().toString())) {
            prefs.setBypass(false);
            showLauncher();
        }
    }

    private boolean active() {
        return prefs != null && prefs.overrideHome() && !prefs.bypass();
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        if (event.getKeyCode() != KeyEvent.KEYCODE_HOME || !active()) return false;
        if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) {
            // Press: Fast Launcher. Hold: the original Amazon home screen.
            if (event.getEventTime() - event.getDownTime() >= LONG_PRESS_MS) {
                Launchers.openStockHome(this);
            } else {
                showLauncher();
            }
        }
        return true;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (prefs == null || event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkg = event.getPackageName();
        if (pkg == null) return;
        if (pkg.toString().equals(getPackageName())) {
            // Back in Fast Launcher: the Home button belongs to us again.
            prefs.setBypass(false);
        } else if (active() && stockLaunchers.contains(pkg.toString())) {
            showLauncher();
        }
    }

    private void showLauncher() {
        long now = SystemClock.uptimeMillis();
        if (now - lastLaunch < DEBOUNCE_MS) return;
        lastLaunch = now;
        Launchers.tryStart(this, Launchers.showLauncher(this));
    }

    @Override
    public void onInterrupt() {}
}
