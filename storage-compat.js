(() => {
  'use strict';
  // Copy once; retain the source so older open tabs cannot lose their data.
  const aliases = [
    ['exposureManager.v1', 'betreeExposureManager.v1'],
    ['exposureFugleWsKey.v1', 'betreeFugleWsKey.v1'],
    ['exposureIndexRisk.v1', 'betreeIndexRisk.v1']
  ];
  try {
    for (const [current, previous] of aliases) {
      const value = localStorage.getItem(previous);
      if (localStorage.getItem(current) === null && value !== null) {
        localStorage.setItem(current, value);
      }
    }
  } catch (error) {
    console.warn('Local storage migration unavailable', error.name);
  }
})();
