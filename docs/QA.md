# Device QA checklist

Run on a real iPhone (owner's) and a low-end Android phone before each TestFlight / Play beta. Tick what passes; file the rest as issues with the build number.

## Build
- [ ] EAS `preview` build installs on both devices; app name, icon and splash are right; version/build number match the release notes.
- [ ] Boot with airplane mode on: home screen, lessons and a local game work; no error screen (the secure-random check passes on Hermes).
- [ ] UI language follows the device: zh-Hant device → Traditional Chinese; others → English; Settings override switches at once.

## Local play
- [ ] 20 hands against bots on each device without a crash or a frozen table; the result sheet reads Verified each time.
- [ ] Portrait and landscape, and rotation mid-hand; iPad all four orientations; safe areas and the keyboard (name field) never cover controls.
- [ ] Coach panel, review, daily puzzle, Puzzle Rush, drills each opened once; progress survives a force-quit.
- [ ] Table stays at ~60 fps during bot play on the Android (profile; if below 50 fps, pre-render tile faces).

## Accounts and online
- [ ] First online action creates a guest; the guest survives a reinstall only after signing in with Apple/Google (expected).
- [ ] Sign in with Apple (iOS) and Google (both) succeed; linking a guest keeps clubs and progress; "Sign out" and "Delete account" behave as the copy says.
- [ ] Create a club, open a table, join from the other device by code; bots fill empty seats; clocks and time banks run; the audit shows Verified on both phones.
- [ ] Kill the app mid-hand and relaunch: Resume returns to the same seat with the same hand.
- [ ] Airplane mode for 30 s mid-hand: Reconnecting banner, then the table continues without losing the seat.
- [ ] Redeploy the server mid-hand (owner triggers a deploy): the table continues after the restart.

## Store and legal (once Phase 4 ships)
- [ ] Sandbox purchase of each SKU credits the wallet; Restore Purchases recovers Coach Gold on a fresh install.
- [ ] Terms, privacy policy, age gate and account deletion are reachable from Settings.

## Audio (once Phase 5 ships)
- [ ] Every call is audible, no overlap, the sound toggle works, silent switch respected on iOS.
