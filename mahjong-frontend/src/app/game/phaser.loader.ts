let phaserPromise: Promise<any> | null = null;

export function loadPhaser(): Promise<any> {
  if (phaserPromise) return phaserPromise;

  if (typeof window === 'undefined') {
    return Promise.reject('Phaser can only load in the browser');
  }

  phaserPromise = import(
    /* @vite-ignore */
    'phaser'
  );

  return phaserPromise;
}
