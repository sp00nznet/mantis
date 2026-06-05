// Smoke test for Phase 3: agentskills.io (SKILL.md) skills + create_skill tool.
import os from 'os'; import path from 'path'; import fs from 'fs';

const home = path.join(os.tmpdir(), 'mantis-skills-' + Date.now().toString(36));
const proj = path.join(home, 'project');
fs.mkdirSync(proj, { recursive: true });
process.env.MANTIS_HOME = home;
// skills.js reads USER_SKILLS_DIR from os.homedir()/.mantis — override HOME so it lands in tmp.
process.env.HOME = home;
process.env.USERPROFILE = home;

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n); } };

const skills = await import('../src/skills.js');
const tools = await import('../src/tools.js');
tools.setWorkingDirectory(proj);

// --- 1. Hand-author a folder (SKILL.md) skill in the user dir ---
const userSkillsDir = path.join(home, '.mantis', 'skills');
fs.mkdirSync(path.join(userSkillsDir, 'deploy'), { recursive: true });
fs.writeFileSync(path.join(userSkillsDir, 'deploy', 'SKILL.md'),
`---
name: deploy
description: Build and ship the release
argument-hint: "[env]"
---
Deploy to {{#if args}}{{args}}{{else}}staging{{/if}}:
1. Run the build.
2. Push the artifact.
`);
// bundle a resource file next to it
fs.writeFileSync(path.join(userSkillsDir, 'deploy', 'checklist.md'), '- smoke test\n');

const all = skills.getAllSkills();
const deploy = all.find(s => s.name === 'deploy');
check('folder skill discovered', !!deploy);
check('folder skill format=md', deploy?.format === 'md');
check('frontmatter description parsed', deploy?.description === 'Build and ship the release');
check('argument-hint parsed', deploy?.args === '[env]');
check('builtin skills still present', all.some(s => s.name === 'commit'));

// --- 2. Template expansion + resource note ---
const expandedNoArgs = skills.expandSkillPrompt(deploy, '');
check('conditional else branch', expandedNoArgs.includes('Deploy to staging'));
check('resource note lists bundled file', expandedNoArgs.includes('checklist.md'));
const expandedArgs = skills.expandSkillPrompt(deploy, 'production');
check('conditional if branch with args', expandedArgs.includes('Deploy to production'));

// --- 3. matchSkillCommand routes /deploy ---
const matched = skills.matchSkillCommand('/deploy production');
check('slash command matches', matched && matched.skill.name === 'deploy' && matched.args === 'production');

// --- 4. JSON skills still load (back-compat) ---
fs.writeFileSync(path.join(userSkillsDir, 'legacy.json'),
  JSON.stringify({ name: 'legacy', description: 'old style', prompt: 'do {{args}}' }));
check('json skill still loads', skills.getAllSkills().some(s => s.name === 'legacy' && s.format === 'json'));

// --- 5. create_skill tool writes a portable folder skill ---
const out = await tools.executeTool('create_skill', {
  name: 'Lint Fix',
  description: 'Run the linter and fix what it reports',
  instructions: '1. Run the linter.\n2. Fix each error.\n3. Re-run to confirm.',
  argument_hint: '[path]',
  scope: 'user',
});
check('create_skill reports success', /Saved skill "\/lint-fix"/.test(out));
const written = path.join(userSkillsDir, 'lint-fix', 'SKILL.md');
check('create_skill wrote SKILL.md', fs.existsSync(written));
const back = skills.getSkill('lint-fix');
check('created skill is loadable', back && back.format === 'md' && /Run the linter/.test(back.prompt));
check('created skill name sanitized', back?.name === 'lint-fix');

// --- 6. project scope writes into .mantis/skills ---
const out2 = await tools.executeTool('create_skill', {
  name: 'projcheck', description: 'project check', instructions: 'check things', scope: 'project',
});
check('project skill created', fs.existsSync(path.join(proj, '.mantis', 'skills', 'projcheck', 'SKILL.md')));

// --- 7. delete handles folder form ---
check('deleteSkill removes folder skill', skills.deleteSkill('lint-fix', 'user') === true);
check('deleted skill gone', !skills.getSkill('lint-fix'));

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
