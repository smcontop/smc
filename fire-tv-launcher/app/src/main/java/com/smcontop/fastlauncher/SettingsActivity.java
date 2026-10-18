package com.smcontop.fastlauncher;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class SettingsActivity extends Activity {
    private Prefs prefs;
    private TextView status;
    private LinearLayout options;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);
        prefs = new Prefs(this);
        status = findViewById(R.id.status);
        options = findViewById(R.id.options);
    }

    @Override
    protected void onResume() {
        super.onResume();
        build();
    }

    private void build() {
        boolean serviceOn = Launchers.isServiceEnabled(this);
        boolean override = prefs.overrideHome();
        if (!serviceOn) {
            status.setText("The Home button still opens the Amazon home screen. To make it open Fast Launcher, "
                    + "turn on \"" + getString(R.string.service_label) + "\" in Accessibility settings.");
        } else if (override) {
            status.setText("The Home button opens Fast Launcher. Use \"Open Amazon Home\" any time to visit the "
                    + "original home screen.");
        } else {
            status.setText("The Home button opens the Amazon home screen (paused below).");
        }

        options.removeAllViews();
        add(serviceOn ? "Accessibility settings (service is ON)" : "Turn on Home button service…", () ->
                open(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        add(override ? "Home button → Fast Launcher (tap to pause)" : "Home button → Amazon Home (tap to resume)",
                () -> {
                    prefs.setOverrideHome(!override);
                    build();
                });
        add("Open Amazon Home (original home screen)", () -> {
            if (!Launchers.openStockHome(this)) toast("Couldn't find the Amazon home screen");
        });
        Set<String> hidden = prefs.hidden();
        add("Hidden apps (" + hidden.size() + ")…", this::editHidden);
        add("Reset favorites and hidden apps", () -> new AlertDialog.Builder(this)
                .setMessage("Reset favorites and unhide all apps?")
                .setPositiveButton(android.R.string.ok, (d, w) -> {
                    prefs.resetLayout();
                    build();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show());
        options.getChildAt(0).requestFocus();
    }

    private void editHidden() {
        Set<String> hidden = prefs.hidden();
        if (hidden.isEmpty()) {
            toast("No hidden apps");
            return;
        }
        Map<String, String> labels = new HashMap<>();
        for (AppInfo a : Apps.load(this)) labels.put(a.pkg, a.label);
        List<String> pkgs = new ArrayList<>(hidden);
        String[] items = new String[pkgs.size()];
        boolean[] checked = new boolean[pkgs.size()];
        for (int i = 0; i < items.length; i++) {
            String label = labels.get(pkgs.get(i));
            items[i] = label != null ? label : pkgs.get(i);
            checked[i] = true;
        }
        new AlertDialog.Builder(this)
                .setTitle("Uncheck apps to show them again")
                .setMultiChoiceItems(items, checked, (d, which, isChecked) -> checked[which] = isChecked)
                .setPositiveButton(android.R.string.ok, (d, w) -> {
                    for (int i = 0; i < checked.length; i++) {
                        if (!checked[i]) hidden.remove(pkgs.get(i));
                    }
                    prefs.setHidden(hidden);
                    build();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void add(String text, Runnable action) {
        TextView chip = new TextView(this, null, 0, R.style.Chip);
        chip.setText(text);
        chip.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = Math.round(10 * getResources().getDisplayMetrics().density);
        options.addView(chip, lp);
    }

    private void open(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (!Launchers.tryStart(this, intent)
                && !Launchers.tryStart(this, new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            toast("Couldn't open settings");
        }
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }
}
