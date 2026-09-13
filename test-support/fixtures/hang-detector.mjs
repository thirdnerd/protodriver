export const TEST_HANG_DETECTOR_MS = 20_000;

/** Keep a broken asynchronous control alive long enough to report its named expectation. */
export async function withHangDetector(promise, expectation) {
  let timer;
  const detector = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${expectation} did not settle within the ${TEST_HANG_DETECTOR_MS} ms hang-detector bound`,
    )), TEST_HANG_DETECTOR_MS);
  });
  try {
    return await Promise.race([promise, detector]);
  } finally {
    clearTimeout(timer);
  }
}
