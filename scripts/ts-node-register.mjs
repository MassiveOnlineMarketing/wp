import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Replace deprecated/experimental `--loader ts-node/esm` with Node's recommended `register()` approach.
register('ts-node/esm', pathToFileURL('./'));
