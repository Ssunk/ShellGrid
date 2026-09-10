<script lang="ts">
  import { Check, SquareTerminal, X } from "lucide-svelte";
  import { getTheme, themeGroups, themes, type ThemeId } from "../lib/themes";

  export let currentTheme: ThemeId;
  export let onSelect: (id: ThemeId) => void;
  export let onClose: () => void;
</script>

<aside id="theme-picker" class="environment-popover theme-popover" aria-labelledby="theme-picker-title">
  <div class="popover-title theme-heading">
    <span id="theme-picker-title">主题风格</span>
    <span class="theme-current-badge">{getTheme(currentTheme).name}</span>
    <button type="button" class="icon-button" aria-label="关闭主题选择" title="关闭主题选择" on:click={onClose}><X size={15} /></button>
  </div>
  <div class="theme-list">
    {#each themeGroups as group}
      <section class="theme-section" aria-label={group.name}>
        <div class="theme-section-heading">
          <h2>{group.name}</h2>
          <span>{themes.filter((theme) => theme.group === group.id).length} 款</span>
        </div>
        <div class="theme-grid">
          {#each themes.filter((theme) => theme.group === group.id) as item (item.id)}
            <button
              type="button"
              class="theme-card"
              class:active={currentTheme === item.id}
              data-theme-id={item.id}
              aria-label={item.name}
              aria-pressed={currentTheme === item.id}
              on:click={() => onSelect(item.id)}
            >
              <span
                class="theme-preview"
                aria-hidden="true"
                style:--preview-background={item.terminal.background}
                style:--preview-surface={item.colors.surface}
                style:--preview-foreground={item.terminal.foreground}
                style:--preview-accent={item.accent}
                style:--preview-cursor={item.terminal.cursor}
              >
                <span class="theme-preview-bar"><SquareTerminal size={10} /><span></span><i></i></span>
                <span class="theme-preview-line"><span class="theme-preview-prompt">❯</span> ShellGrid<span class="theme-preview-cursor"></span></span>
                <span class="theme-preview-palette">
                  {#each [item.terminal.red, item.terminal.green, item.terminal.yellow, item.terminal.blue, item.terminal.magenta, item.terminal.cyan] as color}
                    <i style:background={color}></i>
                  {/each}
                </span>
              </span>
              <span class="theme-card-label">
                <span class="theme-card-info">
                  <strong>{item.name}</strong>
                  <small>{item.desc}</small>
                </span>
                <span class="theme-check" class:selected={currentTheme === item.id} aria-hidden="true">
                  {#if currentTheme === item.id}<Check size={12} strokeWidth={2.5} />{/if}
                </span>
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>
  <p class="theme-hint">界面与终端同步切换 · 自动记住选择</p>
</aside>
