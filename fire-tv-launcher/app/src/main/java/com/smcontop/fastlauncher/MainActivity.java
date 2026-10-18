package com.smcontop.fastlauncher;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.media.tv.TvContract;
import android.media.tv.TvInputInfo;
import android.media.tv.TvInputManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * tvOS-style home: a dock of favorites at the bottom with the focused app's name and glow above it,
 * the full app grid below, and one glass highlight that glides between tiles.
 * Visual design adapted from tv-vibehack by Gathin23 (MIT).
 */
public class MainActivity extends Activity {
    private static final float FOCUS_SCALE = 1.10f;
    private static final long MINUTE_MS = 60_000L;

    /** Survive activity recreation so the home screen redraws instantly and focus returns where it was. */
    private static List<AppInfo> cachedApps;
    private static String focusKey;

    private final ExecutorService worker = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());

    private Prefs prefs;
    private LayoutInflater inflater;
    private float density;
    private View root;
    private ScrollView scroll;
    private View spacer;
    private View dock;
    private LinearLayout favoritesRow;
    private View favoritesHint;
    private LinearLayout appsGrid;
    private GlassView glass;
    private View ambient;
    private TextView heroName;
    private TextView greeting;
    private View btnInputs;
    private GradientDrawable ambientGlow;
    private int ambientColor;
    private boolean heroShown;
    private boolean glassShown;
    private View focusedCard;
    private AlertDialog dialog;
    private PopupWindow popup;

    private final Runnable minuteTick = new Runnable() {
        @Override
        public void run() {
            updateGreeting();
            main.postDelayed(this, MINUTE_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        prefs = new Prefs(this);
        inflater = getLayoutInflater();
        density = getResources().getDisplayMetrics().density;
        root = findViewById(R.id.root);
        scroll = findViewById(R.id.scroll);
        spacer = findViewById(R.id.spacer);
        dock = findViewById(R.id.dock);
        favoritesRow = findViewById(R.id.favorites_row);
        favoritesHint = findViewById(R.id.favorites_hint);
        appsGrid = findViewById(R.id.apps_grid);
        glass = findViewById(R.id.glass);
        ambient = findViewById(R.id.ambient);
        heroName = findViewById(R.id.hero_name);
        greeting = findViewById(R.id.greeting);
        btnInputs = findViewById(R.id.btn_inputs);

        ambientGlow = new GradientDrawable();
        ambientGlow.setGradientType(GradientDrawable.RADIAL_GRADIENT);
        ambientGlow.setGradientCenter(0.32f, 0.42f);
        ambient.setBackground(ambientGlow);
        ambient.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) ->
                ambientGlow.setGradientRadius((r - l) * 0.62f));

        // Park the dock at the bottom of the screen; the grid waits below it.
        View.OnLayoutChangeListener fit = (v, l, t, r, b, ol, ot, or, ob) -> updateSpacer();
        scroll.addOnLayoutChangeListener(fit);
        dock.addOnLayoutChangeListener(fit);
        // Keep the glass on its tile while the rows scroll.
        scroll.getViewTreeObserver().addOnScrollChangedListener(() -> {
            if (glassShown && focusedCard != null) moveGlass(focusedCard, false);
        });
        getWindow().getDecorView().getViewTreeObserver().addOnGlobalFocusChangeListener((oldF, newF) -> {
            if (newF == null || newF.getId() != R.id.card) {
                hideGlass();
                hideHero();
            }
        });

        btnInputs.setOnClickListener(v -> showInputs());
        findViewById(R.id.btn_amazon_home).setOnClickListener(v -> {
            if (!Launchers.openStockHome(this)) toast(R.string.cant_open);
        });
        findViewById(R.id.btn_settings).setOnClickListener(v ->
                start(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
        findViewById(R.id.btn_launcher_settings).setOnClickListener(v ->
                start(new Intent(this, SettingsActivity.class)));
        setupTopButtonKeys();
        if (!passthroughInputs().isEmpty()) btnInputs.setVisibility(View.VISIBLE);

        if (cachedApps != null) render();
    }

    @Override
    protected void onStart() {
        super.onStart();
        prefs.setBypass(false);
        refreshApps();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateGreeting();
        main.postDelayed(minuteTick, MINUTE_MS);
        // Coming back from an app: the focused tile gets no new focus event, so restore the glass by hand.
        View focused = getCurrentFocus();
        if (focused != null && focused.getId() == R.id.card) {
            glassShown = false;
            main.post(() -> onCardFocused(focused));
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        main.removeCallbacks(minuteTick);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Home pressed while already here: back to the first favorite.
        if (dialog != null) dialog.dismiss();
        if (popup != null) popup.dismiss();
        focusKey = null;
        focusFirst();
    }

    @Override
    public void onBackPressed() {
        // This is the home screen; Back from the grid returns to the dock, otherwise nothing.
        View focused = getCurrentFocus();
        if (focused != null && focused.getId() == R.id.card && !isInDock(focused)) focusFirst();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        worker.shutdownNow();
    }

    // ---- apps ------------------------------------------------------------------------------------

    /** Re-reads installed apps in the background; redraws only if something changed. */
    private void refreshApps() {
        worker.execute(() -> {
            List<AppInfo> apps = Apps.load(this);
            main.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (cachedApps != null && sameApps(cachedApps, apps)) return;
                Set<String> pkgs = new HashSet<>();
                for (AppInfo a : apps) pkgs.add(a.pkg);
                prefs.seedFavorites(pkgs);
                cachedApps = apps;
                render();
            });
        });
    }

    private static boolean sameApps(List<AppInfo> a, List<AppInfo> b) {
        if (a.size() != b.size()) return false;
        for (int i = 0; i < a.size(); i++) {
            if (!a.get(i).component.equals(b.get(i).component) || !a.get(i).label.equals(b.get(i).label)) {
                return false;
            }
        }
        return true;
    }

    private void render() {
        Map<String, AppInfo> byPkg = new HashMap<>();
        for (AppInfo a : cachedApps) byPkg.put(a.pkg, a);
        Set<String> hidden = prefs.hidden();

        focusedCard = null;
        favoritesRow.removeAllViews();
        for (String pkg : prefs.favorites()) {
            AppInfo app = byPkg.get(pkg);
            if (app != null) favoritesRow.addView(tile(app, true));
        }
        favoritesHint.setVisibility(favoritesRow.getChildCount() == 0 ? View.VISIBLE : View.GONE);

        appsGrid.removeAllViews();
        int columns = columns();
        LinearLayout row = null;
        for (AppInfo app : cachedApps) {
            if (hidden.contains(app.pkg)) continue;
            if (row == null || row.getChildCount() == columns) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setClipChildren(false);
                row.setClipToPadding(false);
                row.setPadding(0, 0, 0, Math.round(8 * density));
                appsGrid.addView(row);
            }
            row.addView(tile(app, false));
        }

        View restore = focusKey == null ? null : scroll.findViewWithTag(focusKey);
        if (restore != null) {
            restore.requestFocus();
        } else {
            focusFirst();
        }
    }

    private int columns() {
        int width = getResources().getDisplayMetrics().widthPixels
                - 2 * getResources().getDimensionPixelSize(R.dimen.edge_h) - Math.round(28 * density);
        int tile = getResources().getDimensionPixelSize(R.dimen.tile_w)
                + getResources().getDimensionPixelSize(R.dimen.tile_gap);
        return Math.max(1, width / tile);
    }

    private void focusFirst() {
        scroll.scrollTo(0, 0);
        View first = favoritesRow.getChildCount() > 0 ? favoritesRow.getChildAt(0)
                : appsGrid.getChildCount() > 0 ? ((ViewGroup) appsGrid.getChildAt(0)).getChildAt(0)
                : null;
        if (first != null) first.findViewById(R.id.card).requestFocus();
    }

    private void updateSpacer() {
        int want = Math.max(0, scroll.getHeight() - dock.getHeight() - Math.round(30 * density));
        ViewGroup.LayoutParams lp = spacer.getLayoutParams();
        if (lp.height != want) {
            lp.height = want;
            spacer.setLayoutParams(lp);
        }
    }

    private boolean isInDock(View card) {
        return card.getTag() instanceof String && ((String) card.getTag()).startsWith("f:");
    }

    // ---- tiles -----------------------------------------------------------------------------------

    private View tile(AppInfo app, boolean inDock) {
        View v = inflater.inflate(R.layout.tile, inDock ? favoritesRow : appsGrid, false);
        View card = v.findViewById(R.id.card);
        TextView name = v.findViewById(R.id.name);
        card.setTag((inDock ? "f:" : "a:") + app.pkg);
        card.setContentDescription(app.label);
        card.setClipToOutline(true);
        name.setText(app.label);
        // Dock tiles show their name as the big title above the dock instead.
        name.setVisibility(inDock ? View.GONE : View.VISIBLE);

        Apps.Art cached = Apps.cachedArt(app.pkg);
        if (cached != null) {
            showArt(v, app, cached);
        } else {
            worker.execute(() -> {
                Apps.Art art = Apps.art(this, app);
                main.post(() -> showArt(v, app, art));
            });
        }

        card.setOnClickListener(x -> start(Apps.launchIntent(app)));
        card.setOnLongClickListener(x -> {
            showOptions(app, inDock);
            return true;
        });
        card.setOnKeyListener((x, keyCode, event) -> {
            if (keyCode != KeyEvent.KEYCODE_MENU) return false;
            if (event.getAction() == KeyEvent.ACTION_UP) showOptions(app, inDock);
            return true;
        });
        card.setOnFocusChangeListener((x, hasFocus) -> {
            float s = hasFocus ? FOCUS_SCALE : 1f;
            x.animate().scaleX(s).scaleY(s)
                    .setDuration(hasFocus ? 240 : 160)
                    .setInterpolator(new OvershootInterpolator(hasFocus ? 1.4f : 0f))
                    .start();
            name.animate().alpha(hasFocus ? 1f : 0f)
                    .translationY(hasFocus ? 4 * density : 0f)
                    .setDuration(200).start();
            if (hasFocus) onCardFocused(x);
        });
        return v;
    }

    private void showArt(View tile, AppInfo app, Apps.Art art) {
        ImageView banner = tile.findViewById(R.id.banner);
        ImageView icon = tile.findViewById(R.id.icon);
        TextView label = tile.findViewById(R.id.label);
        if (art.isBanner) {
            banner.setImageDrawable(art.drawable);
            banner.setVisibility(View.VISIBLE);
            icon.setVisibility(View.GONE);
            label.setVisibility(View.GONE);
        } else {
            banner.setVisibility(View.GONE);
            icon.setImageDrawable(art.drawable);
            icon.setVisibility(View.VISIBLE);
            label.setText(app.label);
            label.setVisibility(View.VISIBLE);
        }
    }

    private void onCardFocused(View card) {
        focusedCard = card;
        focusKey = (String) card.getTag();
        moveGlass(card, true);
        if (isInDock(card)) {
            scroll.smoothScrollTo(0, 0);
            showHero(card);
        } else {
            hideHero();
            // Scroll enough to show the name under the tile and the glass around it, not just the tile.
            View item = (View) card.getParent();
            int pad = Math.round(12 * density);
            item.requestRectangleOnScreen(new Rect(0, -pad, item.getWidth(), item.getHeight() + pad), false);
        }
    }

    // ---- glass highlight and top shelf -----------------------------------------------------------

    private void moveGlass(View card, boolean glide) {
        // Tile rect in root coordinates, from layout positions (ignores the focus scale).
        Rect r = new Rect(0, 0, card.getWidth(), card.getHeight());
        try {
            ((ViewGroup) root).offsetDescendantRectToMyCoords(card, r);
        } catch (IllegalArgumentException detached) {
            return;
        }
        float pad = GlassView.INSET_DP * density;
        float w = card.getWidth() * FOCUS_SCALE + 2 * pad;
        float h = card.getHeight() * FOCUS_SCALE + 2 * pad;
        float x = r.exactCenterX() - w / 2f;
        float y = r.exactCenterY() - h / 2f;

        ViewGroup.LayoutParams lp = glass.getLayoutParams();
        if (lp.width != (int) w || lp.height != (int) h) {
            lp.width = (int) w;
            lp.height = (int) h;
            glass.setLayoutParams(lp);
            glass.setRadius(14f * density * FOCUS_SCALE);
        }
        if (!glassShown) {
            glass.animate().cancel();
            glass.setTranslationX(x);
            glass.setTranslationY(y);
            glass.animate().alpha(1f).setDuration(160).start();
            glassShown = true;
        } else if (glide) {
            glass.animate().translationX(x).translationY(y).alpha(1f)
                    .setDuration(230).setInterpolator(new OvershootInterpolator(0.9f)).start();
        } else {
            glass.animate().translationX(x).translationY(y).alpha(1f)
                    .setDuration(90).setInterpolator(new DecelerateInterpolator()).start();
        }
    }

    private void hideGlass() {
        if (!glassShown) return;
        glassShown = false;
        focusedCard = null;
        glass.animate().alpha(0f).setDuration(140).start();
    }

    private void showHero(View card) {
        String pkg = ((String) card.getTag()).substring(2);
        CharSequence label = card.getContentDescription();
        Apps.Art art = Apps.cachedArt(pkg);
        int color = art != null ? art.color : 0xFF444444;

        // Where the dock lands once scrolled to the top.
        Rect s = new Rect(0, 0, scroll.getWidth(), scroll.getHeight());
        ((ViewGroup) root).offsetDescendantRectToMyCoords(scroll, s);
        float y = s.top + spacer.getLayoutParams().height - 24 * density - heroName.getHeight();

        if (!heroShown) {
            heroName.setText(label);
            heroName.setY(y);
            heroName.setTranslationX(0f);
            heroName.animate().alpha(1f).setDuration(240).start();
            setAmbient(color);
            ambient.animate().alpha(1f).setDuration(500).start();
            heroShown = true;
        } else if (!label.toString().contentEquals(heroName.getText())) {
            heroName.animate().alpha(0f).translationX(-12 * density).setDuration(110).withEndAction(() -> {
                heroName.setText(label);
                heroName.setY(y);
                heroName.setTranslationX(12 * density);
                heroName.animate().alpha(1f).translationX(0f).setDuration(180).start();
            }).start();
            if (color != ambientColor) {
                ambient.animate().alpha(0.35f).setDuration(180).withEndAction(() -> {
                    setAmbient(color);
                    ambient.animate().alpha(1f).setDuration(420).start();
                }).start();
            }
        } else {
            heroName.setY(y);
        }
    }

    private void setAmbient(int color) {
        ambientColor = color;
        int c = color & 0x00FFFFFF;
        ambientGlow.setColors(new int[]{0x5C000000 | c, 0x26000000 | c, c});
    }

    private void hideHero() {
        if (!heroShown) return;
        heroShown = false;
        heroName.animate().alpha(0f).setDuration(150).start();
        ambient.animate().alpha(0f).setDuration(280).start();
    }

    // ---- top bar ---------------------------------------------------------------------------------

    /** Keep focus on the button row at its ends and top instead of jumping to a far-away tile. */
    private void setupTopButtonKeys() {
        ViewGroup bar = findViewById(R.id.top_buttons);
        View.OnKeyListener keys = (v, keyCode, event) -> {
            if (event.getAction() != KeyEvent.ACTION_DOWN) return false;
            if (keyCode == KeyEvent.KEYCODE_DPAD_UP) return true;
            if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN) {
                focusFirst();
                return true;
            }
            List<View> shown = new ArrayList<>();
            for (int i = 0; i < bar.getChildCount(); i++) {
                if (bar.getChildAt(i).getVisibility() == View.VISIBLE) shown.add(bar.getChildAt(i));
            }
            if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) return v == shown.get(0);
            return keyCode == KeyEvent.KEYCODE_DPAD_RIGHT && v == shown.get(shown.size() - 1);
        };
        for (int i = 0; i < bar.getChildCount(); i++) bar.getChildAt(i).setOnKeyListener(keys);
    }

    private void updateGreeting() {
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        int res = hour < 5 ? R.string.good_night
                : hour < 12 ? R.string.good_morning
                : hour < 17 ? R.string.good_afternoon
                : hour < 22 ? R.string.good_evening
                : R.string.good_night;
        greeting.setText(res);
    }

    /** HDMI first in port order, then AV and others. Empty on devices without TV inputs (sticks, cubes). */
    private List<TvInputInfo> passthroughInputs() {
        List<TvInputInfo> out = new ArrayList<>();
        try {
            TvInputManager tim = (TvInputManager) getSystemService(TV_INPUT_SERVICE);
            if (tim == null) return out;
            for (TvInputInfo info : tim.getTvInputList()) {
                if (info.isPassthroughInput()) out.add(info);
            }
        } catch (RuntimeException ignored) {
            return out;
        }
        Collections.sort(out, (a, b) -> {
            boolean ha = a.getType() == TvInputInfo.TYPE_HDMI, hb = b.getType() == TvInputInfo.TYPE_HDMI;
            if (ha != hb) return ha ? -1 : 1;
            return String.valueOf(a.loadLabel(this)).compareToIgnoreCase(String.valueOf(b.loadLabel(this)));
        });
        return out;
    }

    /** Dropdown under the Inputs pill listing HDMI/AV inputs. Adapted from tv-vibehack (MIT). */
    private void showInputs() {
        List<TvInputInfo> inputs = passthroughInputs();
        if (inputs.isEmpty()) return;
        LinearLayout rows = (LinearLayout) inflater.inflate(R.layout.popup_inputs, (ViewGroup) root, false);
        int width = Math.max(btnInputs.getWidth(), Math.round(170 * density));
        popup = new PopupWindow(rows, width, ViewGroup.LayoutParams.WRAP_CONTENT, true);
        popup.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));   // lets Back dismiss it
        popup.setOutsideTouchable(true);
        popup.setAnimationStyle(0);

        for (TvInputInfo info : inputs) {
            boolean hdmi = info.getType() == TvInputInfo.TYPE_HDMI;
            CharSequence l = info.loadLabel(this);
            String label = l == null ? info.getId() : l.toString();
            if (hdmi && !label.toUpperCase(java.util.Locale.ROOT).contains("HDMI")) label = "HDMI " + label;
            View row = inflater.inflate(R.layout.item_input, rows, false);
            ((ImageView) row.findViewById(R.id.icon)).setImageResource(R.drawable.ic_input);
            ((TextView) row.findViewById(R.id.title)).setText(label);
            String id = info.getId();
            row.setOnClickListener(v -> {
                popup.dismiss();
                start(new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(TvContract.buildChannelUriForPassthroughInput(id),
                                "vnd.android.cursor.item/channel")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            });
            rows.addView(row);
        }

        rows.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        popup.setWidth(Math.max(width, rows.getMeasuredWidth()));
        rows.setAlpha(0f);
        rows.setPivotY(0f);
        rows.setScaleY(0.92f);
        rows.setTranslationY(-8 * density);
        popup.showAsDropDown(btnInputs, 0, Math.round(10 * density), Gravity.START);
        rows.animate().alpha(1f).scaleY(1f).translationY(0f).setDuration(200)
                .setInterpolator(new DecelerateInterpolator(1.6f)).start();
        rows.getChildAt(0).requestFocus();
    }

    // ---- per-app options -------------------------------------------------------------------------

    private void showOptions(AppInfo app, boolean inDock) {
        List<String> favorites = prefs.favorites();
        int index = favorites.indexOf(app.pkg);
        List<Integer> labels = new ArrayList<>();
        List<Runnable> actions = new ArrayList<>();

        if (index < 0) {
            labels.add(R.string.add_favorite);
            actions.add(() -> {
                favorites.add(app.pkg);
                prefs.setFavorites(favorites);
                focusKey = "a:" + app.pkg;
                render();
            });
        } else {
            if (inDock && index > 0) {
                labels.add(R.string.move_left);
                actions.add(() -> moveFavorite(favorites, index, index - 1));
            }
            if (inDock && index < favorites.size() - 1) {
                labels.add(R.string.move_right);
                actions.add(() -> moveFavorite(favorites, index, index + 1));
            }
            labels.add(R.string.remove_favorite);
            actions.add(() -> {
                favorites.remove(app.pkg);
                prefs.setFavorites(favorites);
                focusKey = null;
                render();
            });
        }
        labels.add(R.string.hide_app);
        actions.add(() -> {
            Set<String> hidden = prefs.hidden();
            hidden.add(app.pkg);
            prefs.setHidden(hidden);
            favorites.remove(app.pkg);
            prefs.setFavorites(favorites);
            focusKey = null;
            render();
        });
        labels.add(R.string.app_info);
        actions.add(() -> start(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + app.pkg)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
        labels.add(R.string.uninstall);
        actions.add(() -> {
            Apps.forget(app.pkg);
            start(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + app.pkg)));
        });

        CharSequence[] items = new CharSequence[labels.size()];
        for (int i = 0; i < items.length; i++) items[i] = getString(labels.get(i));
        dialog = new AlertDialog.Builder(this)
                .setTitle(app.label)
                .setItems(items, (d, which) -> actions.get(which).run())
                .show();
    }

    private void moveFavorite(List<String> favorites, int from, int to) {
        favorites.add(to, favorites.remove(from));
        prefs.setFavorites(favorites);
        focusKey = "f:" + favorites.get(to);
        render();
    }

    private void start(Intent intent) {
        if (!Launchers.tryStart(this, intent)) toast(R.string.cant_open);
    }

    private void toast(int res) {
        Toast.makeText(this, res, Toast.LENGTH_SHORT).show();
    }
}
