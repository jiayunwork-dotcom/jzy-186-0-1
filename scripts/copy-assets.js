// 跨平台构建资产拷贝：nest build(tsc) 不会复制 .sql。
const fs = require('fs');
const path = require('path');

const copies = [
  ['src/persistence/schema.sql', 'dist/persistence/schema.sql'],
];

for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
