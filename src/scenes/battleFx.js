/**
 * battleFx —— 战场特效层（M7）
 *
 * 职责：所有"看得见的动作"都在这里实现，与逻辑层彻底分离。
 *   - 伤害飘字：`-40` 上浮淡出
 *   - 攻击前冲：攻击方朝目标方向冲一下再弹回
 *   - 受击抖动：目标原地左右晃
 *   - 施法光环：目标位置画一圈扩散的光环
 *   - 阵亡淡出：兵牌缩小下沉淡出后销毁
 *   - 击杀提示：飘 `-N` 的同时补一个 "×3" 的击杀数
 *
 * ── 动画与刷新打架的问题 ────────────────────────────────────
 *   BattleScene.refresh() 会在数据变化时调用，而 refresh 之后
 *   兵牌视图会被增量更新（位置/血条/数量）。
 *   如果动画正在把兵牌往某个位置 tween，refresh 把它拽回去，动画就废了。
 *
 *   解法：动画开始时给 view 打上 `animating = true`，
 *   refreshUnitView 看到 animating 就**不动它的位置**，
 *   动画结束时再清标记。
 *   （位置最终由 refreshUnitView 在下一帧补齐，不会错位。）
 */

import { cellCenter } from './battleView.js';

/**
 * 飘伤害数字
 *
 * @param {Phaser.Scene} scene
 * @param {number} x 屏幕坐标
 * @param {number} y 屏幕坐标
 * @param {string|number} text 文字（如 -40 或 40）
 * @param {object} [opts] { color, prefix, delay, fontSize }
 * @returns {object} Phaser.GameObjects.Text
 */
export function floatText(scene, x, y, text, opts = {}) {
  const color = opts.color || '#ff6b6b';
  const t = scene.add.text(x, y, text, {
    fontSize: opts.fontSize || '20px',
    color,
    stroke: '#000000',
    strokeThickness: 4
  }).setOrigin(0.5).setDepth(950);

  scene.tweens.add({
    targets: t,
    y: y - 40,
    alpha: 0,
    duration: 900,
    delay: opts.delay || 0,
    ease: 'Cubic.easeOut',
    onComplete: () => t.destroy()
  });

  return t;
}

/**
 * 移动平移动画
 *
 * 把兵牌从 from 格平移到 to 格。
 * 期间给 view 打 animating 标记，阻止 refreshUnitView 把位置拽回去。
 *
 * @param {Phaser.Scene} scene
 * @param {object} view
 * @param {{x:number,y:number}} from 起点格
 * @param {{x:number,y:number}} to 终点格
 * @param {function} [onDone]
 */
export function playMoveTo(scene, view, from, to, onDone) {
  if (!view || !view.root) {
    if (onDone) onDone();
    return;
  }
  const a = cellCenter(from);
  const b = cellCenter(to);
  view.animating = true;

  scene.tweens.add({
    targets: view.root,
    x: b.x,
    y: b.y,
    duration: 220,
    ease: 'Cubic.easeOut',
    onComplete: () => {
      // 收尾时强制对齐一次，避免浮点误差导致位置偏移
      view.root.x = b.x;
      view.root.y = b.y;
      view.animating = false;
      if (onDone) onDone();
    }
  });
}

/**
 * 伤害飘字（红色负数）+ 可选的击杀数
 *
 * @param {Phaser.Scene} scene
 * @param {object} stack 被打击的 stack
 * @param {number} damage
 * @param {number} [killed]
 */
export function floatDamage(scene, stack, damage, killed = 0) {
  if (!stack) return;
  const c = cellCenter(stack.pos);
  floatText(scene, c.x, c.y - 18, `-${damage}`, { color: '#ff6b6b' });
  if (killed > 0) {
    floatText(scene, c.x, c.y + 4, `×${killed}`, {
      color: '#ffd93d',
      fontSize: '16px',
      delay: 120
    });
  }
}

/**
 * 攻击前冲动画
 *
 * 攻击方朝目标方向冲一段距离再弹回原位。
 * 期间给 view 打 animating 标记，防止 refresh 把位置拽回去。
 *
 * ⚠️ 前冲动的是 **root**（整块兵牌的位移），
 *    而受击抖动动的是 **body**（兵牌内部晃动）——
 *    两者分开，"前冲中又被反击"也不会互相打架。
 *
 * @param {Phaser.Scene} scene
 * @param {object} atkView 攻击方视图
 * @param {object} defStack 目标 stack（用来算方向）
 * @param {function} [onImpact] 冲到位的瞬间回调（用来触发伤害飘字）
 */
export function playAttackLunge(scene, atkView, defStack, onImpact) {
  if (!atkView || !atkView.root) {
    if (onImpact) onImpact();
    return;
  }

  const target = cellCenter(defStack.pos);
  const baseX = atkView.root.x;
  const baseY = atkView.root.y;
  const dx = target.x - baseX;
  const dy = target.y - baseY;
  const len = Math.max(1, Math.hypot(dx, dy));
  // 前冲距离：最多 26px，至少 10px
  const dist = Math.max(10, Math.min(26, len * 0.45));
  const ux = dx / len;
  const uy = dy / len;

  atkView.animating = true;

  scene.tweens.add({
    targets: atkView.root,
    x: baseX + ux * dist,
    y: baseY + uy * dist,
    duration: 130,
    ease: 'Quad.easeOut',
    onComplete: () => {
      if (onImpact) onImpact();
      scene.tweens.add({
        targets: atkView.root,
        x: baseX,
        y: baseY,
        duration: 180,
        ease: 'Quad.easeInOut',
        onComplete: () => {
          atkView.root.x = baseX;
          atkView.root.y = baseY;
          atkView.animating = false;
        }
      });
    }
  });
}

/**
 * 受击抖动动画
 *
 * @param {Phaser.Scene} scene
 * @param {object} defView 被击方视图
 * @param {function} [onDone]
 */
export function playHitShake(scene, defView, onDone) {
  if (!defView || !defView.body) {
    if (onDone) onDone();
    return;
  }

  defView.animating = true;
  const body = defView.body;

  scene.tweens.add({
    targets: body,
    x: { from: -7, to: 7 },
    duration: 55,
    yoyo: true,
    repeat: 3,
    onComplete: () => {
      body.x = 0;
      defView.animating = false;
      if (onDone) onDone();
    }
  });
}

/**
 * 施法光环特效
 *
 * 在目标位置画一个扩散的圆环。
 *
 * @param {Phaser.Scene} scene
 * @param {object} stack 目标 stack
 * @param {number} [color]
 */
export function playSpellAura(scene, stack, color = 0x9b59b6) {
  if (!stack) return;
  const c = cellCenter(stack.pos);

  const ring = scene.add.circle(c.x, c.y, 12)
    .setStrokeStyle(4, color)
    .setDepth(940);
  const glow = scene.add.circle(c.x, c.y, 6, color, 0.5).setDepth(940);

  scene.tweens.add({
    targets: ring,
    radius: 34,
    alpha: 0,
    duration: 420,
    ease: 'Cubic.easeOut',
    onComplete: () => ring.destroy()
  });
  scene.tweens.add({
    targets: glow,
    radius: 26,
    alpha: 0,
    duration: 420,
    ease: 'Cubic.easeOut',
    onComplete: () => glow.destroy()
  });
}

/**
 * 治疗光环特效（绿色，与敌对的紫色区分）
 * @param {Phaser.Scene} scene
 * @param {object} stack
 */
export function playHealAura(scene, stack) {
  playSpellAura(scene, stack, 0x2ecc71);
}

/**
 * 阵亡淡出动画
 *
 * 缩小 + 下沉 + 淡出，结束后回调（由 BattleScene 销毁视图）。
 *
 * @param {Phaser.Scene} scene
 * @param {object} view
 * @param {function} onDone
 */
export function playDeathFade(scene, view, onDone) {
  if (!view) {
    if (onDone) onDone();
    return;
  }
  view.dying = true;
  view.animating = true;
  // 隐藏血条与徽章，只留兵牌主体做淡出
  view.hpBarBg.setVisible(false);
  view.hpBar.setVisible(false);
  view.buffLayer.setVisible(false);
  view.abilityLayer.setVisible(false);
  view.rangeText.setVisible(false);
  view.selRing.setVisible(false);
  view.turnRing.setVisible(false);

  scene.tweens.add({
    targets: view.body,
    scale: 0.3,
    alpha: 0,
    y: 14,
    duration: 380,
    ease: 'Cubic.easeIn',
    onComplete: () => {
      if (onDone) onDone();
    }
  });
}

/**
 * 当前行动单位的金色描边闪烁
 *
 * 只对 view.turnRing 做 alpha 循环，切换单位时重启 tween。
 *
 * @param {Phaser.Scene} scene
 * @param {object} view
 */
export function startTurnGlow(scene, view) {
  if (!view || !view.turnRing) return;
  view.turnRing.setVisible(true);
  view.turnRing.setAlpha(1);
  scene.tweens.killTweensOf(view.turnRing);
  scene.tweens.add({
    targets: view.turnRing,
    alpha: { from: 1, to: 0.25 },
    duration: 520,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut'
  });
}

/**
 * 停止金色描边闪烁
 * @param {Phaser.Scene} scene
 * @param {object} view
 */
export function stopTurnGlow(scene, view) {
  if (!view || !view.turnRing) return;
  scene.tweens.killTweensOf(view.turnRing);
  view.turnRing.setAlpha(1);
  view.turnRing.setVisible(false);
}

/**
 * 屏幕震动（击杀较多时用）
 * @param {Phaser.Scene} scene
 * @param {number} [intensity]
 */
export function shakeScreen(scene, intensity = 0.006) {
  scene.cameras.main.shake(220, intensity);
}
