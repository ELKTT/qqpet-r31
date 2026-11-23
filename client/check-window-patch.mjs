import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {sharedName} from '../tools/community-entry-r29-20261018/shared-name.mjs';
import {windowPlacement} from '../tools/community-entry-r29-20261018/window-placement.mjs';
import {swfStructure, swfLayout} from '../server/src/deployment/swf-strings.js';

const patches = new Map([
  ['window-placement', windowPlacement()],
  ['shared-name', sharedName()],
]);
const movies = [
  'common/petsoc/world_1051.swf',
  'common/petsoc/homelogic2v.swf',
  'common/petsoc/FlashMessageBox.swf',
  'res/Plugins/MessageManager/FlashMessageBox.swf',
];

function checkMovie(root, relative) {
  const movie = readFileSync(join(root, relative));
  const blocks = swfStructure(movie).abcs.map((_, index) => swfLayout(movie, {abcOrdinal: index}).abc);
  for (const [name, bytes] of patches) {
    if (blocks.filter(block => block.equals(bytes)).length !== 1) {
      throw new Error(`${relative} / ${name}`);
    }
  }
  console.log(`OK ${relative}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  for (const [name, bytes] of patches) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    console.log(`${digest}  ${name} (${bytes.length} bytes)`);
  }
} else if (args.length === 1) {
  for (const movie of movies) checkMovie(args[0], movie);
} else {
  console.error('Usage: node client/check-window-patch.mjs [QQPenguin-folder]');
  process.exitCode = 2;
}
