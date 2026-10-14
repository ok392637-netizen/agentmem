// 把自写的 dsh 唤起插件装进 dsh 的 web profile。
//
// 为什么需要这个脚本：插件必须待在 profile 的 node_modules 里才被 cordis 解析到，
// 而那个目录是 pnpm 管的 —— `dsh plugin add/remove` 或一次 pnpm install 就可能把它抹掉，
// 而且抹掉之后**不报错**，只是自动唤起悄悄停了。源码放仓库里，用这个脚本重新装。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'dsh-plugin');
const DST = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'agentmem-dsh-recall');
fs.mkdirSync(path.join(DST, 'lib'), { recursive: true });
for (const rel of ['package.json', path.join('lib', 'index.js')]) {
  fs.copyFileSync(path.join(SRC, rel), path.join(DST, rel));
  console.log(`  已装 ${rel}`);
}
console.log(`装到 ${DST}`);
console.log('记得 web/cordis.patch.yml 里要有 insert: agentmem-dsh-recall（已配过就不用动）。');
