// ============================================================
//  开机自动重注入的台账逻辑：机器上装着两份 Mineradio 时，卸一份不能把另一份的开机检查弄没
//
//  这一条只测**决策**（留不留 Run 键、台账剩谁），不碰注册表也不碰 %LOCALAPPDATA%：
//  Run 键是全局的，测试机上去写一条会把人家的开机行为改掉。
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { planTargetsAfterUnregister } from '../lib/autostart.mjs';

test('还剩别的目录在管时，Run 键必须留着', () => {
  const a = 'D:\\Mineradio\\resources\\app';
  const b = 'E:\\Games\\Mineradio\\resources\\app';
  const first = planTargetsAfterUnregister([{ appDir: a }, { appDir: b }], a);
  assert.equal(first.rest.length, 1, '另一份要留在台账里');
  assert.equal(first.rest[0].appDir, b);
  assert.equal(first.keepRunKey, true,
    '还有别的目录在管就绝不能删 Run 键 —— 那是另一份唯一的开机检查，删了以后更新就补不回来了');
});

test('最后一份也撤完了才该删 Run 键', () => {
  const last = planTargetsAfterUnregister([{ appDir: 'D:\\Mineradio\\resources\\app' }], 'D:\\Mineradio\\resources\\app');
  assert.equal(last.rest.length, 0);
  assert.equal(last.keepRunKey, false);
});

test('同一个目录写成不同样式（正斜杠、盘符大小写）要认得出是同一份', () => {
  const same = planTargetsAfterUnregister([{ appDir: 'C:/x/resources/app' }], 'C:\\x\\resources\\app');
  assert.equal(same.rest.length, 0, '当成两份的话，卸完一份 Run 键还被留着，指向的却是没人管的目录');
});

test('台账为空或没登记过这个目录时都不该崩', () => {
  assert.deepEqual(planTargetsAfterUnregister([], 'D:\\a').rest, []);
  assert.equal(planTargetsAfterUnregister([], 'D:\\a').keepRunKey, false);
  const other = planTargetsAfterUnregister([{ appDir: 'D:\\b' }], 'D:\\a');
  assert.equal(other.rest.length, 1, '没登记过的目录撤起来不该把别人的台账清空');
  assert.equal(other.keepRunKey, true);
});
