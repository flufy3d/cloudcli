import { assert } from 'vitest';

// Vitest executes client tests in jsdom, where Vite externalizes Node's assert
// module. Keep existing node-style assertions working through Vitest's browser
// compatible assertion object instead of selecting React's production build.
export default assert;
