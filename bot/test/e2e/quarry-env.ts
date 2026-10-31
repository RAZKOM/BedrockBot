// Track BK: the quarry e2e (quarry.test.ts) uses the builder's helpers (build-truth.ts: an afk-task bot
// wired like the CLI, truth:blocksdiff) on bds-dig (udp/19148) instead of bds-build. Imported first, it
// points build-truth's BUILD_BDS_* at QUARRY_BDS_HOST / QUARRY_BDS_PORT / QUARRY_BDS_CONTAINER (default
// 127.0.0.1, 19148, bds-dig; bds-explore on 19198 works too) before build-truth reads them.
process.env.BUILD_BDS_HOST = process.env.QUARRY_BDS_HOST ?? '127.0.0.1';
process.env.BUILD_BDS_PORT = process.env.QUARRY_BDS_PORT ?? '19148';
process.env.BUILD_BDS_CONTAINER = process.env.QUARRY_BDS_CONTAINER ?? 'bds-dig';
if (process.env.QUARRY_VERBOSE === '1') process.env.BUILD_VERBOSE = '1';

export {};
