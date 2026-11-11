# Douyin Thread Ripper
参照项目 https://github.com/MrTangLuyao/Bilibili-thread-ripper
Chrome MV3 extension for accelerating Douyin Web while keeping Douyin's native
player and UI.

## Install

Packaged build: [Douyin-Thread-Ripper-v0.2.7.zip](dist/Douyin-Thread-Ripper-v0.2.7.zip)

For the packaged build, unzip it first, then load the extracted directory with
Chrome's **Load unpacked** button. Chrome does not load this ZIP directly as an
installed extension.

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable Developer mode.
4. Choose **Load unpacked** and select the repository directory.
5. Open or reload `https://www.douyin.com/`.

The extension does not replace the Douyin player, fabricate media signatures, or
require exported cookies. It accelerates eligible Range requests inside the
existing logged-in browser session.

## v0.2.7 architecture

Douyin feed metadata is observed from fetch or XHR and used to build a
candidate registry from real url_list values only. No CDN hostname is invented.

Media path:

    Douyin media fetch(douyinvod, Range)
      -> exact prefetch-cache hit?
      -> adaptive strategy: native / 2-way / 3-way
      -> validated CDN selection per sub-range
      -> strict 206 + Content-Range + byte-length validation
      -> ordered byte reassembly
      -> synthetic 206 Response
      -> original Douyin media pipeline

SIDX path:

    init/index Range
      -> parse fMP4 SIDX
      -> learn exact segment byte ranges
      -> prefetch next segment
      -> in-flight dedupe + bounded memory cache
      -> seek generation cancels stale-direction work

## Safety rules

- Never rewrites or invents CDN hostnames.
- Never fabricates signatures.
- Only real Douyin-provided or actually observed douyinvod URLs can enter the
  candidate pool.
- A distinct alternate CDN must pass same-resource byte verification at the
  head, middle and tail before it can carry media bytes.
- fid and webid are only copied from the already-playable runtime URL onto an
  otherwise unchanged Douyin-provided candidate when missing.
- Media XHR is never replaced. Small init/index XHR responses are observed read-only to seed SIDX segment maps.
- Any sub-range validation or network failure cancels sibling work and falls
  back to Douyin's original fetch.
- Original AbortSignal is honored.
- Prefetch entries are isolated by the full resource URL, request headers and
  relevant fetch options. Requests requiring revalidation bypass prefetch.
- Old SIDX indexes, CDN candidate groups and validation records are bounded;
  evicted records fall back to normal observation and validation.
- Runtime statistics never include signed query values or cookies.

## Adaptive defaults

- Normal split threshold: 512 KiB
- Slow-host 2-way threshold: 320 KiB
- Max pieces: 3
- Global sub-request concurrency: 6
- Fast-host threshold: 60 ms EWMA TTFB
- 3-way threshold: 180 ms EWMA TTFB
- Prefetch: next 1 SIDX segment
- Prefetch cache: 16 MiB
- Prefetch join budget: 120 ms
- Timeout: 8 seconds
- One transient retry

Fast, healthy hosts are allowed to stay on native fetch. A host with measured
EWMA TTFB at or above 180 ms may use 2-way splitting for 320-512 KiB video
ranges; smaller audio-sized ranges remain native. Larger slow ranges can move
to 3-way. This is intentionally not maximum threads all the time.

The SIDX observer checks any media Range up to 128 KiB, not only byte zero, so
an index carried in a later small range can still seed exact next-segment
prefetch.

## Multi-CDN behavior

The resolver is fully implemented, but it degrades safely to one CDN when the
current Douyin payload contains only duplicate URLs on the same host. It never
pretends that duplicate entries are independent CDNs.

## Measured result

One local production-session A/B run on 2026-09-19 used six real Douyin media
Range samples (about 0.84-2.46 MiB), with four paired Native/DTR runs per sample,
alternating order and using `cache: no-store`.

- Native median: about 280 ms
- DTR v0.2.3 median: about 193 ms
- Median reduction: about 31%
- Native p95: about 524 ms
- DTR p95: about 338 ms
- DTR won 22 of 24 paired comparisons

This is a point-in-time measurement on one network/session, not a universal
performance guarantee. The same run exposed only one distinct media CDN host, so
the measured improvement came primarily from adaptive Range concurrency rather
than multi-CDN switching.

## Test philosophy

Unit tests cover Range invariants, SIDX parsing, CDN byte verification and
health selection, fallback and abort behavior, cache/prefetch generation
safety, and reconstructed byte equality.

Run the tests with Node.js:

```powershell
Get-ChildItem dev -File -Filter '*.test.js' | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

The current suite covers CDN candidate isolation by representation, multi-point
byte verification, adaptive Native/2-way/3-way decisions, abort/fallback
semantics, SIDX parsing, and segment-prefetch cache behavior.

An optional browser integration test uses Node.js 22 or later and an isolated
Microsoft Edge profile; it loads the unpacked extension and exercises the page
hook, byte-exact Range reconstruction and popup settings using intercepted
fixture responses. It does not use the user's browser profile or real credentials.

```powershell
node dev/browser-smoke.js
```

Set `DTR_BROWSER` to another Chromium-based browser executable if needed. The
browser must support loading unpacked extensions from the command line. Adding
`--live` also attempts real Douyin playback; login or a verification challenge
can prevent that optional check from completing.

To test the ZIP's contents rather than the working tree, run
`node dev/browser-smoke.js --package`. The test extracts the archive to a
temporary directory, loads it with a disposable browser profile, and checks POST
pass-through, byte-exact Range reconstruction, malformed-range fallback, CDN
verification and rejection, SIDX prefetch from fetch and XHR, and popup
configuration. The test requires `tar` to be available on PATH.

For a controlled local comparison, run `node dev/http-benchmark.js`. It makes
six alternating paired requests to a loopback server that independently limits
each response's rate and checks the reconstructed bytes. Its timings describe
that artificial setup only; they do not measure real Douyin performance.

## Current limitations

- `douyinvod.com` and its subdomains are eligible for interception. On the
  shared `zjcdn.com` network, only the observed hosts
  `v5-dy-ov-experiment.zjcdn.com` and `v5-hl-mly-ov.zjcdn.com` and matching
  Douyin media paths are eligible. Other hosts and paths pass through unchanged.
  These two hosts use same-host splitting; they are not added to the alternate
  CDN pool. Further Douyin CDN host or path variants may also pass through.
  A playing video and a nonzero extension counter do not by themselves prove
  that every media request for that video was accelerated.
- Multi-CDN selection only activates when Douyin actually exposes distinct,
  equivalent media CDN candidates that pass byte verification.
- The extension does not invent alternate CDN domains or generate Douyin
  signatures.
- Performance depends on segment size, CDN behavior, connection reuse, and the
  user's network path.
- This project accelerates media delivery; it is not a general-purpose
  geolocation or account-access bypass.
