/**
 * 交互式发布脚本
 * 支持选择发布 @wecom/wecom-openclaw-plugin 或 @tencent/wecom-openclaw-plugin
 * 支持手动输入版本号
 *
 * 用法：node scripts/publish-all.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PKG_PATH = resolve(ROOT, 'package.json');

const isDryRun = process.argv.includes('--dry-run');

// ============ 包配置映射 ============
const PACKAGES = [
  {
    name: '@wecom/wecom-openclaw-plugin',
    pluginId: 'wecom-openclaw-plugin',
    npmSpec: '@wecom/wecom-openclaw-plugin',
    localPath: 'extensions/wecom-openclaw-plugin',
    registry: 'https://registry.npmjs.org/',
  },
  {
    name: '@tencent/wecom-openclaw-plugin',
    pluginId: 'wecom-openclaw-plugin',
    npmSpec: '@tencent/wecom-openclaw-plugin',
    localPath: 'extensions/wecom-openclaw-plugin',
    registry: 'https://mirrors.tencent.com/npm/',
    // 发布到 @tencent scope 时，需要将代码中的 SDK 引用从 @wecom 替换为 @tencent
    sdkReplace: {
      from: '@wecom/aibot-node-sdk',
      to: '@tencent/aibot-node-sdk',
      depVersion: '^1.0.2',
    },
  },
];

// ============ 工具函数 ============
const readJSON = (filePath) => JSON.parse(readFileSync(filePath, 'utf-8'));
const writeJSON = (filePath, data) => writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
};

// ============ SDK 引用替换 ============
// 需要替换 SDK import 的文件扩展名
const SDK_REPLACE_EXTS = ['.ts', '.mts', '.js', '.mjs'];
const SDK_REPLACE_EXTRA_FILES = ['rollup.config.mjs'];

/**
 * 收集所有可能包含 SDK 引用的源文件
 */
const collectSourceFiles = () => {
  const files = [];
  // 收集 src 目录下的文件
  const srcDir = resolve(ROOT, 'src');
  if (existsSync(srcDir)) {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isFile() && SDK_REPLACE_EXTS.some((ext) => entry.name.endsWith(ext))) {
        files.push(resolve(srcDir, entry.name));
      }
    }
  }
  // 收集根目录下的额外文件
  for (const f of SDK_REPLACE_EXTRA_FILES) {
    const p = resolve(ROOT, f);
    if (existsSync(p)) files.push(p);
  }
  // 收集根目录下的 test 文件
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('test') && SDK_REPLACE_EXTS.some((ext) => entry.name.endsWith(ext))) {
      files.push(resolve(ROOT, entry.name));
    }
  }
  return files;
};

/**
 * 批量替换文件中的 SDK 引用，返回被修改文件的原始内容映射 { filePath: originalContent }
 */
const replaceSDKImports = (fromPkg, toPkg) => {
  const backups = {};
  const files = collectSourceFiles();
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    if (content.includes(fromPkg)) {
      backups[filePath] = content;
      const updated = content.replaceAll(fromPkg, toPkg);
      writeFileSync(filePath, updated, 'utf-8');
      console.log(`  ✏️  ${filePath.replace(ROOT + '/', '')} : ${fromPkg} → ${toPkg}`);
    }
  }
  return backups;
};

/**
 * 恢复被替换的文件
 */
const restoreSDKImports = (backups) => {
  for (const [filePath, content] of Object.entries(backups)) {
    writeFileSync(filePath, content, 'utf-8');
  }
  if (Object.keys(backups).length > 0) {
    console.log(`  ✅ 已恢复 ${Object.keys(backups).length} 个源文件的 SDK 引用`);
  }
};

let rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (question) => new Promise((resolve) => {
  // 如果 rl 已关闭，重新创建
  if (rl.closed) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  rl.question(question, (answer) => resolve(answer.trim()));
});

// ============ 版本号校验 ============
const isValidVersion = (version) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
const isBetaVersion = (version) => /-beta/.test(version);

// ============ 主流程 ============
const main = async () => {
  const currentPkg = readJSON(PKG_PATH);
  const currentVersion = currentPkg.version;

  console.log(`\n当前包名: ${currentPkg.name}`);
  console.log(`当前版本: ${currentVersion}`);
  if (isDryRun) console.log('⚠️  Dry-run 模式，不会真正发布\n');

  // 选择要发布的包
  console.log('\n请选择要发布的包：');
  PACKAGES.forEach((pkg, index) => {
    console.log(`  ${index + 1}. ${pkg.name}`);
  });

  const choice = await ask('\n请输入编号 (1/2): ');
  const choiceIndex = parseInt(choice, 10) - 1;

  if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= PACKAGES.length) {
    console.error('❌ 无效的选择');
    rl.close();
    process.exit(1);
  }

  const selectedPkg = PACKAGES[choiceIndex];
  console.log(`\n已选择: ${selectedPkg.name}`);
  console.log(`📦 目标 registry: ${selectedPkg.registry}`);

  // 检查目标 registry 的 npm 登录状态
  try {
    const npmUser = execSync(`npm whoami --registry ${selectedPkg.registry}`, { encoding: 'utf-8' }).trim();
    console.log(`👤 当前 npm 用户: ${npmUser}`);
  } catch {
    console.warn(`\n⚠️  未检测到 ${selectedPkg.registry} 的 npm 登录用户，请先执行 npm login --registry ${selectedPkg.registry}`);
    rl.close();
    process.exit(1);
  }

  // 对于 @wecom/wecom-openclaw-plugin，询问是否发布 beta 版本
  let isBeta = false;
  if (selectedPkg.name === '@wecom/wecom-openclaw-plugin') {
    const betaChoice = await ask('\n是否发布 beta 版本？(y/N): ');
    isBeta = betaChoice.toLowerCase() === 'y';
  }

  // 输入版本号
  const versionHint = isBeta ? `当前: ${currentVersion}，beta 示例: 1.0.8-beta.1` : `当前: ${currentVersion}`;
  const version = await ask(`\n请输入版本号 (${versionHint}): `);

  if (!isValidVersion(version)) {
    console.error(`❌ 无效的版本号: "${version}"，格式应为 x.y.z 或 x.y.z-beta.1`);
    rl.close();
    process.exit(1);
  }

  // beta 版本校验
  if (isBeta && !isBetaVersion(version)) {
    console.error(`❌ 已选择 beta 发布，但版本号 "${version}" 不包含 -beta 标识`);
    rl.close();
    process.exit(1);
  }

  // 如果有 SDK 替换配置，询问是否需要替换
  let shouldReplaceSDK = false;
  if (selectedPkg.sdkReplace) {
    const sdkReplaceChoice = await ask(`\n是否需要替换 SDK 引用？(${selectedPkg.sdkReplace.from} → ${selectedPkg.sdkReplace.to}) (y/N): `);
    shouldReplaceSDK = sdkReplaceChoice.toLowerCase() === 'y';
  }

  // 确认信息
  console.log('\n========== 发布确认 ==========');
  console.log(`  包名:    ${selectedPkg.name}`);
  console.log(`  版本:    ${version}`);
  console.log(`  插件ID:  ${selectedPkg.pluginId}`);
  if (isBeta) console.log(`  Tag:     beta`);
  if (selectedPkg.sdkReplace && shouldReplaceSDK) console.log(`  SDK替换: ${selectedPkg.sdkReplace.from} → ${selectedPkg.sdkReplace.to}`);
  if (selectedPkg.name === '@wecom/wecom-openclaw-plugin') console.log(`  Git Tag: v${version}`);
  console.log(`  Dry-run: ${isDryRun ? '是' : '否'}`);
  console.log('================================\n');

  const confirm = await ask('确认发布？(y/N): ');

  if (confirm.toLowerCase() !== 'y') {
    rl.close();
    console.log('❎ 已取消发布');
    process.exit(0);
  }

  // ============ 备份原始文件 ============
  const originalPkg = readFileSync(PKG_PATH, 'utf-8');
  let sdkBackups = {};

  const restore = () => {
    writeFileSync(PKG_PATH, originalPkg, 'utf-8');
    restoreSDKImports(sdkBackups);
    console.log('\n✅ 已恢复原始文件');
  };

  // 确保异常退出时也能恢复
  process.on('SIGINT', () => { restore(); process.exit(1); });
  process.on('uncaughtException', (err) => { console.error(err); restore(); process.exit(1); });

  try {
    // 如果需要替换 SDK 引用（@tencent scope），在构建前执行
    if (selectedPkg.sdkReplace && shouldReplaceSDK) {
      const { from, to } = selectedPkg.sdkReplace;
      console.log(`\n🔄 替换 SDK 引用: ${from} → ${to}`);
      sdkBackups = replaceSDKImports(from, to);
    }

    // 构建
    console.log('\n🔨 开始构建...');
    run('npm run prebuild && npm run build');

    // 修改 package.json
    console.log(`\n📦 准备发布: ${selectedPkg.name}@${version}`);
    const pkg = readJSON(PKG_PATH);
    pkg.name = selectedPkg.name;
    pkg.version = version;
    pkg.openclaw.extensions = ['./dist/index.esm.js'];
    pkg.openclaw.install.npmSpec = selectedPkg.npmSpec;
    pkg.openclaw.install.localPath = selectedPkg.localPath;
    // 如果有 SDK 替换且用户确认替换，同步修改 dependencies
    if (selectedPkg.sdkReplace && shouldReplaceSDK) {
      const { from, to, depVersion } = selectedPkg.sdkReplace;
      if (pkg.dependencies && pkg.dependencies[from]) {
        delete pkg.dependencies[from];
        pkg.dependencies[to] = depVersion;
      }
    }
    // 发布时移除 devDependencies，减小包体积（恢复时会还原）
    delete pkg.devDependencies;
    writeJSON(PKG_PATH, pkg);

    // 发布
    let publishCmd = isDryRun ? 'npm publish --dry-run' : 'npm publish';
    publishCmd += ` --registry ${selectedPkg.registry}`;
    if (isBeta) {
      publishCmd += ' --tag beta';
    } else {
      // 显式指定 --tag latest，避免 registry 中存在更高版本号（如误发的日期版本）
      // 导致 npm 拒绝隐式应用 latest 标签
      publishCmd += ' --tag latest';
    }
    console.log(`🚀 发布 ${selectedPkg.name}@${version}...`);
    run(publishCmd);

    console.log(`\n🎉 ${selectedPkg.name}@${version} 发布成功！`);

    // 对于 @wecom/wecom-openclaw-plugin，自动打 git tag
    if (selectedPkg.name === '@wecom/wecom-openclaw-plugin' && !isDryRun) {
      const tag = `v${version}`;
      console.log(`\n🏷️  正在创建 Git Tag: ${tag}...`);
      try {
        run(`git tag ${tag}`);
        run(`git push origin ${tag}`);
        console.log(`✅ Git Tag ${tag} 已推送`);
      } catch (err) {
        console.error(`⚠️  Git Tag 创建/推送失败: ${err.message}`);
      }
    }
  } finally {
    // 发布结束后询问是否恢复原始文件，默认不恢复
    const shouldRestore = await ask('\n是否恢复原始文件？(y/N): ');
    if (shouldRestore.toLowerCase() === 'y') {
      restore();
    } else {
      // 即使不完全恢复 package.json，也需要还原 devDependencies
      const currentPkgData = readJSON(PKG_PATH);
      const originalPkgData = JSON.parse(originalPkg);
      if (originalPkgData.devDependencies) {
        currentPkgData.devDependencies = originalPkgData.devDependencies;
        writeJSON(PKG_PATH, currentPkgData);
      }
      // 源文件中的 SDK 引用始终恢复，避免影响本地开发
      restoreSDKImports(sdkBackups);
      console.log('\n⏭️  跳过恢复，package.json 保持发布后的状态（已还原 devDependencies 和源文件 SDK 引用）');
    }
    rl.close();
  }
};

main().catch((err) => {
  console.error('❌ 发布失败:', err);
  process.exit(1);
});
