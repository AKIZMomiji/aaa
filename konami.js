// ===== イースターエッグ: 重力カレンダー (上上下下左右左右) =====
(function() {
  const KONAMI = ['up','up','down','down','left','right','left','right'];
  let progress = 0;
  let triggered = false;

  function isAnyOverlayOpen() {
    return ['editModal','boardOverlay','settingsOverlay','menuOverlay','confirmOverlay','cameraOverlay','imgFullscreen','dialogOverlay','chatOverlay','profileOverlay']
      .some(id => document.getElementById(id)?.classList.contains('active'));
  }

  function feedInput(dir) {
    if (isAnyOverlayOpen() || triggered) { progress = 0; return; }
    if (dir === KONAMI[progress]) {
      progress++;
      if (progress === KONAMI.length) {
        progress = 0;
        triggerGravity();
      }
    } else {
      // やり直し判定: 入力が先頭と一致するなら1からカウント
      progress = (dir === KONAMI[0]) ? 1 : 0;
    }
  }

  function triggerGravity() {
    if (triggered) return;
    triggered = true;

    const grid = document.getElementById('calendarGrid');
    if (!grid) { triggered = false; return; }

    const cells = Array.from(grid.children).filter(c => !c.classList.contains('empty'));
    if (cells.length === 0) { triggered = false; return; }

    const gridRect = grid.getBoundingClientRect();

    // 先に各セルの「現在の見た目上のサイズ・位置」を全部measureしてから
    // grid自体のレイアウトモードを無効化する（測定後でないと位置がズレる）
    const measurements = cells.map(cell => {
      const r = cell.getBoundingClientRect();
      return {
        cell,
        left: r.left - gridRect.left,
        top: r.top - gridRect.top,
        width: r.width,
        height: r.height
      };
    });

    // grid-template-columns由来の暗黙ストレッチで子要素が伸びてしまうのを防ぐため
    // コンテナをdisplay:blockに切り替えてからabsolute配置する
    grid.style.display = 'block';
    grid.style.position = 'relative';
    grid.style.height = gridRect.height + 'px';

    const floorY = window.innerHeight - gridRect.top + 40;
    let maxDuration = 0;

    measurements.forEach(({ cell, left, top, width, height }, i) => {
      cell.style.position = 'absolute';
      cell.style.left = left + 'px';
      cell.style.top = top + 'px';
      cell.style.width = width + 'px';
      cell.style.height = height + 'px';
      cell.style.maxWidth = width + 'px';
      cell.style.maxHeight = height + 'px';
      cell.style.boxSizing = 'border-box';
      cell.style.margin = '0';
      cell.style.zIndex = String(100 + i);
      cell.style.willChange = 'transform';
      cell.style.pointerEvents = 'none';

      const fallDistance = floorY - top;
      const rotate = (Math.random() * 140 - 70).toFixed(1);
      const drift = (Math.random() * 60 - 30).toFixed(0);
      const delay = Math.random() * 220;
      const duration = 650 + Math.random() * 500;
      maxDuration = Math.max(maxDuration, delay + duration);

      cell.style.transition = 'none';
      requestAnimationFrame(() => {
        setTimeout(() => {
          cell.style.transition = \`transform \${duration}ms cubic-bezier(0.55, 0, 1, 0.45)\`;
          cell.style.transform = \`translate(\${drift}px, \${fallDistance}px) rotate(\${rotate}deg)\`;
        }, delay);
      });
    });

    showToast('🪂 重力発生！', false);

    // アニメーション完了後、再入力できるようにする（再描画やリロードでも自然にリセットされる）
    setTimeout(() => { triggered = false; }, maxDuration + 300);
  }

  document.addEventListener('keydown', e => {
    if (isAnyOverlayOpen()) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const dir = map[e.key];
    if (!dir) return;
    feedInput(dir);
  });

  // スワイプでのコナミコード入力（上下左右ジェスチャー）
  (function() {
    let sx = 0, sy = 0;
    const SWIPE_MIN = 35;

    document.addEventListener('touchstart', e => {
      if (isAnyOverlayOpen()) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', e => {
      if (isAnyOverlayOpen()) return;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < SWIPE_MIN) return;

      let dir;
      if (adx > ady) dir = dx > 0 ? 'right' : 'left';
      else dir = dy > 0 ? 'down' : 'up';

      feedInput(dir);
    }, { passive: true });
  })();
})();
