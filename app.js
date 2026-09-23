/* 墨瓷 · Agent Butler 指挥台 — 交互 */

(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- Toast ---------- */
  const toastHost = $("#toastHost");

  function toast(message, ms = 2400) {
    if (!toastHost) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    toastHost.appendChild(el);
    window.setTimeout(() => {
      el.classList.add("out");
      window.setTimeout(() => el.remove(), 220);
    }, ms);
  }

  /* ---------- 进度条入场 ---------- */
  function paintBars() {
    $$(".bar i").forEach((bar) => {
      const w = bar.getAttribute("data-w") || "0";
      requestAnimationFrame(() => {
        bar.style.width = `${w}%`;
      });
    });
  }

  /* ---------- 导航 ---------- */
  function bindNav() {
    $$(".nav-item").forEach((item) => {
      item.addEventListener("click", () => {
        $$(".nav-item").forEach((n) => n.classList.remove("is-active"));
        item.classList.add("is-active");
        const view = item.getAttribute("data-view");
        const label = item.childNodes[2]?.textContent?.trim() || "视图";
        if (view && view !== "brief") {
          toast(`已切换到「${label}」——原型中以指挥台为主舞台`);
        }
      });
    });
  }

  /* ---------- 裁决动作 ---------- */
  function bindDecisions() {
    $$("[data-decision]").forEach((card) => {
      const resolved = $(".d-resolved", card);

      $$("[data-approve]", card).forEach((btn) => {
        btn.addEventListener("click", () => {
          if (card.classList.contains("is-resolved")) return;
          card.classList.add("is-resolved");
          if (resolved) {
            resolved.textContent = "已批准 · 管家正在执行并记录审计轨迹";
          }
          toast("已批准。审计轨迹已写入。");
          refreshCounts();
        });
      });

      $$("[data-reject]", card).forEach((btn) => {
        btn.addEventListener("click", () => {
          if (card.classList.contains("is-resolved")) return;
          card.classList.add("is-resolved");
          if (resolved) {
            resolved.textContent = "已驳回 · 已通知对应智能体调整策略";
          }
          toast("已驳回。智囊会调整策略后重报。");
          refreshCounts();
        });
      });
    });
  }

  function refreshCounts() {
    const open = $$("[data-decision]:not(.is-resolved)").length;
    const badge = $(".nav-item[data-view='approvals'] .count");
    if (badge) {
      if (open === 0) {
        badge.textContent = "—";
        badge.classList.remove("alert");
      } else {
        badge.textContent = String(open);
      }
    }
    const lede = $(".brief-lede");
    if (lede && open === 0) {
      lede.innerHTML =
        "<strong>今日待决事项已清空。</strong>其余事务仍由智囊团按策略自动闭环，未打扰你。";
    }
  }

  /* ---------- 通用 data-toast ---------- */
  function bindToasts() {
    $$("[data-toast]").forEach((el) => {
      el.addEventListener("click", () => toast(el.getAttribute("data-toast")));
    });
  }

  /* ---------- 顶栏 ---------- */
  function bindTopbar() {
    const btnAct = $("#btnAct");
    const btnExpand = $("#btnExpand");
    const btnBell = $("#btnBell");
    const btnQuiet = $("#btnQuiet");

    btnAct?.addEventListener("click", () => {
      const first = $("[data-decision]:not(.is-resolved)");
      if (first) {
        first.scrollIntoView({ behavior: "smooth", block: "center" });
        first.style.outline = "1px solid var(--seal-line)";
        first.style.outlineOffset = "4px";
        window.setTimeout(() => {
          first.style.outline = "";
          first.style.outlineOffset = "";
        }, 1200);
      }
      toast("已定位到待裁决事项");
    });

    btnExpand?.addEventListener("click", () => {
      toast("管家正在展开今日细节…");
    });

    btnBell?.addEventListener("click", () => {
      toast("3 条消息需你亲自回，2 项裁决待定夺");
    });

    btnQuiet?.addEventListener("click", () => {
      toast("今日到此为止。未决事项将于明晨重新汇总。", 3000);
    });

    const search = $("#searchInput");
    search?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && search.value.trim()) {
        toast(`检索「${search.value.trim()}」——原型未接入真实索引`);
        search.blur();
      }
    });

    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search?.focus();
      }
    });
  }

  /* ---------- 启动 ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    paintBars();
    bindNav();
    bindDecisions();
    bindToasts();
    bindTopbar();
  });
})();
