"use strict";

(function () {
  function preferredTheme() {
    try {
      const stored = localStorage.getItem("theme");
      if (stored) return stored;
    } catch (error) {}
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function updateIcon(button, theme) {
    button.textContent = theme === "dark" ? "☀️" : "🌙";
    button.setAttribute("aria-label", theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え");
  }

  document.documentElement.setAttribute("data-theme", preferredTheme());

  document.addEventListener("DOMContentLoaded", function () {
    const button = document.getElementById("themeToggle");
    if (!button) return;

    updateIcon(button, document.documentElement.getAttribute("data-theme") || "light");
    button.addEventListener("click", function () {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("theme", next);
      } catch (error) {}
      updateIcon(button, next);
    });
  });
})();