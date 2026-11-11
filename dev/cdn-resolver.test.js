"use strict";

var assert = require("node:assert/strict");
var resolverApi = require("../src/cdn-resolver.js");

function parseRange(value) {
  var m = /^bytes=(\d+)-(\d+)$/.exec(value || "");
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

async function fixtureFetch(input) {
  var request = input instanceof Request ? input : new Request(input);
  var range = parseRange(request.headers.get("range"));
  if (!range) {
    return new Response("missing range", { status: 400 });
  }

  var length = range.end - range.start + 1;
  var bytes = new Uint8Array(length);
  for (var i = 0; i < bytes.length; i += 1) {
    bytes[i] = (range.start + i) % 251;
  }

  return new Response(bytes, {
    status: 206,
    headers: {
      "content-range":
        "bytes " + range.start + "-" + range.end + "/100000",
      "content-length": String(bytes.length),
      "etag": "same-media"
    }
  });
}

(async function () {
  var resolver = resolverApi.createResolver({
    nativeFetch: fixtureFetch,
    probeBytes: 1024
  });

  resolver.observeMetadata({
    video: {
      play_addr: {
        uri: "video-1",
        url_list: [
          "https://a.douyinvod.com/video/test/media-video-hvc1/?signature=s",
          "https://a.douyinvod.com/video/test/media-video-hvc1/?signature=s&mirror=duplicate-host",
          "https://b.douyinvod.com/video/test/media-video-hvc1/?signature=s"
        ]
      }
    }
  });

  var primary =
    "https://a.douyinvod.com/video/test/media-video-hvc1/?signature=s&fid=f1&webid=w1";

  var rawCandidates = resolver.getCandidates(primary, false);
  assert.equal(rawCandidates.length, 2);
  assert.deepEqual(
    rawCandidates.map(function (value) { return new URL(value).hostname; }).sort(),
    ["a.douyinvod.com", "b.douyinvod.com"]
  );

  resolver.observePlayableUrl(primary);
  await resolver.verifyAlternates(primary);

  var candidates = resolver.getCandidates(primary, true);
  assert.equal(candidates.length, 2);

  var alternate = candidates.find(function (url) {
    return new URL(url).hostname === "b.douyinvod.com";
  });

  assert.ok(alternate);
  assert.equal(new URL(alternate).searchParams.get("fid"), "f1");
  assert.equal(new URL(alternate).searchParams.get("webid"), "w1");

  resolver.recordResult(primary, {
    ok: false
  });
  resolver.recordResult(primary, {
    ok: false
  });

  var picked = resolver.pickCandidate(primary, 256 * 1024, 0);
  assert.equal(new URL(picked).hostname, "b.douyinvod.com");

  var snapshot = resolver.snapshot();
  assert.equal(snapshot.stats.metadataGroups, 1);
  assert.equal(snapshot.stats.distinctCandidateHosts, 2);
  assert.equal(snapshot.stats.verifiedAlternates, 1);
  assert.ok(snapshot.stats.probes >= 1);

  var resolverByRepresentation = resolverApi.createResolver({
    nativeFetch: fixtureFetch,
    probeBytes: 1024
  });

  resolverByRepresentation.observeMetadata({
    video: {
      bit_rate: [
        {
          play_addr: {
            uri: "shared-aweme-uri",
            url_key: "shared-aweme-uri_h264_1080p_1800",
            url_list: [
              "https://a.douyinvod.com/video/rep-a/media-video-avc1/?signature=s",
              "https://b.douyinvod.com/video/rep-a/media-video-avc1/?signature=s"
            ]
          }
        },
        {
          play_addr: {
            uri: "shared-aweme-uri",
            url_key: "shared-aweme-uri_bytevc1_720p_600",
            url_list: [
              "https://c.douyinvod.com/video/rep-b/media-video-hvc1/?signature=s"
            ]
          }
        }
      ]
    }
  });

  var representationPrimary =
    "https://a.douyinvod.com/video/rep-a/media-video-avc1/?signature=s&fid=f1&webid=w1";

  assert.deepEqual(
    resolverByRepresentation.getCandidates(representationPrimary, false)
      .map(function (value) { return new URL(value).hostname; })
      .sort(),
    ["a.douyinvod.com", "b.douyinvod.com"]
  );

  async function mismatchFixtureFetch(input) {
    var request = input instanceof Request ? input : new Request(input);
    var range = parseRange(request.headers.get("range"));
    if (!range) {
      return new Response("missing range", { status: 400 });
    }

    var length = range.end - range.start + 1;
    var bytes = new Uint8Array(length);
    var host = new URL(request.url).hostname;

    for (var j = 0; j < bytes.length; j += 1) {
      bytes[j] = (range.start + j) % 251;
    }

    if (host === "b.douyinvod.com" && range.start > 0 && bytes.length) {
      bytes[0] = (bytes[0] + 1) % 251;
    }

    return new Response(bytes, {
      status: 206,
      headers: {
        "content-range":
          "bytes " + range.start + "-" + range.end + "/100000",
        "content-length": String(bytes.length),
        "etag": "same-media"
      }
    });
  }

  var resolverMismatch = resolverApi.createResolver({
    nativeFetch: mismatchFixtureFetch,
    probeBytes: 1024
  });

  resolverMismatch.observeMetadata({
    video: {
      play_addr: {
        url_key: "video-mid-mismatch",
        url_list: [
          "https://a.douyinvod.com/video/mismatch/media-video-hvc1/?signature=s",
          "https://b.douyinvod.com/video/mismatch/media-video-hvc1/?signature=s"
        ]
      }
    }
  });

  var mismatchPrimary =
    "https://a.douyinvod.com/video/mismatch/media-video-hvc1/?signature=s&fid=f1&webid=w1";
  resolverMismatch.observePlayableUrl(mismatchPrimary);
  await resolverMismatch.verifyAlternates(mismatchPrimary);

  assert.equal(resolverMismatch.getCandidates(mismatchPrimary, true).length, 1);
  assert.equal(resolverMismatch.snapshot().stats.rejectedAlternates, 1);

  var wrongRangeResolver = resolverApi.createResolver({
    nativeFetch: async function () {
      return new Response(new Uint8Array(1024), {
        status: 206, headers: { "content-range": "bytes 0-1023/100000" }
      });
    },
    probeBytes: 1024
  });
  var wrongPrimary = "https://a.douyinvod.com/video/wrong-range";
  wrongRangeResolver.observeMetadata({ video: { play_addr: { url_list: [
    wrongPrimary, "https://b.douyinvod.com/video/wrong-range"
  ] } } });
  await wrongRangeResolver.verifyAlternates(wrongPrimary);
  assert.equal(wrongRangeResolver.getCandidates(wrongPrimary, true).length, 1,
    "an alternate that returns the wrong probe range must not be verified");

  var independentResolver = resolverApi.createResolver({ nativeFetch: fixtureFetch });
  var independentA = "https://a.douyinvod.com/video/independent";
  var independentB = "https://b.douyinvod.com/video/independent";
  independentResolver.observeMetadata({ video: { play_addr: { url_list: [independentA, independentB] } } });
  independentResolver.observePlayableUrl(independentA);
  independentResolver.observePlayableUrl(independentB);
  assert.equal(independentResolver.getCandidates(independentA, true).length, 1,
    "observed playable URLs must not be trusted as equivalent without pair verification");
  await independentResolver.verifyAlternates(independentA);
  assert.equal(independentResolver.getCandidates(independentA, true).length, 2);
  assert.equal(independentResolver.getCandidates(independentB, true).length, 1,
    "verification must be scoped to the primary and candidate pair");

  var boundedResolver = resolverApi.createResolver({ nativeFetch: fixtureFetch });
  for (var groupNumber = 0; groupNumber < 300; groupNumber += 1) {
    boundedResolver.observeMetadata({ video: { play_addr: { url_key: "group-" + groupNumber,
      url_list: ["https://a.douyinvod.com/video/bounded-" + groupNumber] } } });
  }
  assert.ok(boundedResolver.snapshot().stats.metadataGroups <= 256, "old CDN groups must be bounded");
  var manyCandidates = Array.from({ length: 80 }, function (_, number) {
    return "https://a.douyinvod.com/video/one-group?version=" + number;
  });
  boundedResolver.observeMetadata({ video: { play_addr: { url_key: "one-group", url_list: manyCandidates } } });
  assert.ok(boundedResolver.snapshot().stats.candidateUrls <= 256 + 32,
    "a single group must not accumulate unlimited signed URLs");
  boundedResolver.observeMetadata({ video: { play_addr: { url_key: "recent-group", url_list: [
    "https://a.douyinvod.com/video/recent", "https://b.douyinvod.com/video/recent"
  ] } } });
  assert.equal(boundedResolver.getCandidates("https://a.douyinvod.com/video/recent", false).length, 2,
    "bounded registry must preserve current CDN candidates");

  var sharedPathResolver = resolverApi.createResolver({ nativeFetch: fixtureFetch });
  sharedPathResolver.observeMetadata({ list: [
    { url_key: "old-shared", url_list: ["https://a.douyinvod.com/video/shared"] },
    { url_key: "retained-shared", url_list: ["https://a.douyinvod.com/video/shared", "https://b.douyinvod.com/video/shared"] }
  ] });
  for (var j = 0; j < 255; j += 1) {
    sharedPathResolver.observeMetadata({ url_key: "filler-" + j,
      url_list: ["https://a.douyinvod.com/video/filler-" + j] });
  }
  assert.equal(sharedPathResolver.getCandidates("https://a.douyinvod.com/video/shared", false).length, 2,
    "evicting one group must not remove another group's shared path mapping");

  var capacityResolver = resolverApi.createResolver({
    probeBytes: 256,
    nativeFetch: async function (request) {
      var range = parseRange(request.headers.get("range"));
      return new Response(new Uint8Array(range.end - range.start + 1), {
        status: 206, headers: { "content-range": "bytes " + range.start + "-" + range.end + "/1024" }
      });
    }
  });
  var capacityBase = "https://a.douyinvod.com/video/capacity";
  capacityResolver.observeMetadata({ url_list: [capacityBase, "https://b.douyinvod.com/video/capacity"] });
  for (var k = 0; k < 2050; k += 1) {
    await capacityResolver.verifyAlternates(capacityBase + "?fid=" + k);
  }
  assert.equal(capacityResolver.getCandidates(capacityBase + "?fid=0", true).length, 1,
    "evicted validation must not be trusted");
  assert.equal(capacityResolver.getCandidates(capacityBase + "?fid=2049", true).length, 2,
    "recent validation must remain available");
  var probesBeforeRecheck = capacityResolver.snapshot().stats.probes;
  await capacityResolver.verifyAlternates(capacityBase + "?fid=0");
  assert.equal(capacityResolver.snapshot().stats.probes, probesBeforeRecheck + 1,
    "evicted validation must be checked again");
  assert.equal(capacityResolver.getCandidates(capacityBase + "?fid=0", true).length, 2);

  var resolverReact = resolverApi.createResolver({
    nativeFetch: fixtureFetch,
    probeBytes: 1024
  });

  resolverReact.observeMetadata({
    video: {
      uri: "react-video-uri",
      playAddr: [
        { src: "https://a.douyinvod.com/video/react-default/media-video-avc1/?signature=s" },
        { src: "https://b.douyinvod.com/video/react-default/media-video-avc1/?signature=s" }
      ],
      playAddrH265: [
        { src: "https://c.douyinvod.com/video/react-h265/media-video-hvc1/?signature=s" },
        { src: "https://d.douyinvod.com/video/react-h265/media-video-hvc1/?signature=s" }
      ],
      bitRateList: [
        {
          uri: "react-video-uri",
          fileId: "file-h265-720",
          playAddr: [
            { src: "https://e.douyinvod.com/video/react-720/media-video-hvc1/?signature=s" },
            { src: "https://f.douyinvod.com/video/react-720/media-video-hvc1/?signature=s" }
          ]
        },
        {
          uri: "react-video-uri",
          fileId: "file-h264-1080",
          playAddr: [
            { src: "https://g.douyinvod.com/video/react-1080/media-video-avc1/?signature=s" }
          ]
        }
      ]
    }
  });

  assert.deepEqual(
    resolverReact.getCandidates(
      "https://a.douyinvod.com/video/react-default/media-video-avc1/?signature=s&fid=f1&webid=w1",
      false
    ).map(function (value) { return new URL(value).hostname; }).sort(),
    ["a.douyinvod.com", "b.douyinvod.com"]
  );

  assert.deepEqual(
    resolverReact.getCandidates(
      "https://c.douyinvod.com/video/react-h265/media-video-hvc1/?signature=s&fid=f1&webid=w1",
      false
    ).map(function (value) { return new URL(value).hostname; }).sort(),
    ["c.douyinvod.com", "d.douyinvod.com"]
  );

  assert.deepEqual(
    resolverReact.getCandidates(
      "https://e.douyinvod.com/video/react-720/media-video-hvc1/?signature=s&fid=f1&webid=w1",
      false
    ).map(function (value) { return new URL(value).hostname; }).sort(),
    ["e.douyinvod.com", "f.douyinvod.com"]
  );

  console.log("cdn-resolver.test.js: ok");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
