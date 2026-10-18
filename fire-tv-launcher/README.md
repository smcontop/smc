# Fast Launcher for Fire TV

A tiny (~40 KB), ad-free home screen for Fire TV devices, including Hisense Fire TV sets, with
an Apple TV-style look.

- **Opens instantly.** No ads, no sponsored rows, no network, no libraries, nothing running in the background.
- **A dock of favorites** at the bottom of a black screen. The focused app's name shows in large
  type above it, with a soft glow in a colour taken from the app's own artwork.
- **All your apps in a grid** that slides up when you press Down.
- **One floating glass highlight** that glides from tile to tile.
- **A greeting, a big clock and the date**, plus buttons for **Inputs** (HDMI, on TVs), **Amazon Home**,
  **Settings** and **Launcher**.
- Built for the remote: hold **OK** (or press **☰**) on any app to favorite, reorder, hide, see app info, or uninstall it.
  **Back** from the grid jumps to the dock, and **Home** always returns to your first favorite.
- **The original Amazon home screen is never removed or disabled.** You can go back to it at any time.

## Install

1. On the TV: **Settings → My Fire TV → About**, then click the device name 7 times to unlock **Developer Options**.
2. **Settings → My Fire TV → Developer Options**: turn on **Apps from Unknown Sources** (or **Install unknown apps** → allow *Downloader*).
3. Get the APK onto the TV, either way works:
   - **Downloader app**: install *Downloader* from the Amazon Appstore and enter the APK's download link.
   - **ADB from a computer**: turn on **ADB debugging**, then run `adb connect <TV-IP>` and `adb install -r FastLauncher.apk`.
4. Open **Fast Launcher** from *Your Apps & Channels*.

## Make the Home button open Fast Launcher

Fire OS always sends Home to Amazon's launcher, so Fast Launcher includes an optional accessibility
service that catches the Home button and opens Fast Launcher instead.

In Fast Launcher, choose **Launcher → Turn on Home button service…**, or go to
**Settings → Accessibility** and turn on **Fast Launcher Home button**.

If that setting doesn't appear on your firmware, you can turn it on from a computer:

```sh
adb shell settings put secure enabled_accessibility_services com.smcontop.fastlauncher/.HomeButtonService
adb shell settings put secure accessibility_enabled 1
```

Once it's on, Fast Launcher also comes up by itself when the TV boots.

## Going back to the Amazon home screen

You have several options, from temporary to permanent:

| Want | Do this |
|---|---|
| Visit Amazon Home once | **Hold the Home button** for about a second, or press **Amazon Home** at the top of Fast Launcher. Home keeps you there until you open Fast Launcher again. |
| Use Amazon Home for a while | **Launcher → Home button → tap to pause**. Tap again to resume. |
| Switch back for good | Turn off **Fast Launcher Home button** in **Settings → Accessibility**, or just uninstall Fast Launcher. |

## Build it yourself

You need JDK 17+ and the Android SDK (platform 34).

```sh
cd fire-tv-launcher
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Every push to GitHub builds the APK automatically (**Actions → Build Fire TV launcher APK → Artifacts**). Pushing a tag
such as `launcher-v1.0` also attaches the APK to a GitHub Release.

### Signing

With no key configured, builds are signed with the standard Android debug key. Each CI run gets a
different debug key, so you'd have to uninstall before installing a newer build. To keep one stable
key, create a keystore once:

```sh
keytool -genkeypair -keystore release.jks -alias fastlauncher -keyalg RSA -keysize 2048 -validity 36500
```

Then add these repository secrets: `KEYSTORE_BASE64` (output of `base64 -w0 release.jks`),
`KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`. Never commit the keystore itself.

## Credits

The visual design (dock, top shelf with ambient glow, glass highlight, Inputs menu) is adapted from
[tv-vibehack](https://github.com/Gathin23/tv-vibehack) by Gathin23, under the MIT License. That
project replaces the launcher on Android TV and Google TV by making it the default Home over ADB,
which Fire OS doesn't allow. That's why this one uses an accessibility service for the Home button instead.
