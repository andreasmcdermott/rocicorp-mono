import {definePreset} from 'unbuild';

// @see https://github.com/unjs/unbuild
export default definePreset({
  clean: true,
  declaration: true,
  externals: [
    'cors',
    'firebase-functions',
    'firebase-admin',
    'body-parser',
    'busboy',
    'mirror-protocol',
    'mirror-schema',
    'shared',
  ],
  rollup: {
    inlineDependencies: true,
    esbuild: {
      minify: false,
    },
  },
});
