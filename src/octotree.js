$(document).ready(() => {
  const store = new Storage();

  parallel(Object.keys(STORE), (key, cb) => store.setIfNull(STORE[key], DEFAULTS[key], cb), loadExtension);

  async function loadExtension() {
    const $html = $('html');
    const $document = $(document);
    const $dom = $(TEMPLATE);
    const $sidebar = $dom.find('.octotree_sidebar');
    const $toggler = $sidebar.find('.octotree_toggle');
    const $spinner = $sidebar.find('.octotree_spin');
    const $views = $sidebar.find('.octotree_view');
    const $pinner = $sidebar.find('.octotree_pin');
    const adapter = createAdapter();
    const treeView = new TreeView($dom, store, adapter);
    const optsView = new OptionsView($dom, store);
    const helpPopup = new HelpPopup($dom, store);
    const errorView = new ErrorView($dom, store);
    let currRepo = false;
    let hasError = false;

    $pinner.click(togglePin);
    $toggler.mouseenter(() => toggleSidebar(true));
    $document.on('click', (event) => {
      if (!isSidebarPinned() && isSidebarVisible() && isOutsideSidebar(event.target)) toggleSidebar(false);
    });

    handleSidebarAutoToggling();
    handleHotKeys(store.get(STORE.HOTKEYS));

    $html.addClass(ADDON_CLASS);

    $(window).resize((event) => {
      if (event.target === window) layoutChanged();
    });

    for (const view of [treeView, errorView, optsView]) {
      $(view)
        .on(EVENT.VIEW_READY, function(event) {
          if (this !== optsView) {
            $document.trigger(EVENT.REQ_END);
          }
          showView(this.$view);
        })
        .on(EVENT.VIEW_CLOSE, () => showView(hasError ? errorView.$view : treeView.$view))
        .on(EVENT.OPTS_CHANGE, optionsChanged)
        .on(EVENT.FETCH_ERROR, (event, err) => showError(err));
    }

    $document
      .on(EVENT.REQ_START, () => $spinner.addClass('octotree_loading'))
      .on(EVENT.REQ_END, () => $spinner.removeClass('octotree_loading'))
      .on(EVENT.LAYOUT_CHANGE, layoutChanged)
      .on(EVENT.PIN, layoutChanged)
      .on(EVENT.LOC_CHANGE, () => tryLoadRepo());

    $sidebar
      .width(parseInt(store.get(STORE.WIDTH)))
      .resize(() => layoutChanged(true))
      .appendTo($('body'));

    adapter.init($sidebar);

    await pluginManager.activate({
      store,
      adapter,
      $document,
      $dom,
      $sidebar,
      $toggler,
      $views,
      treeView,
      optsView,
      errorView
    });

    return tryLoadRepo();

    /**
     * Creates the platform adapter. Currently only support GitHub.
     */
    function createAdapter() {
      const normalizeUrl = (url) => url.replace(/(.*?:\/\/[^/]+)(.*)/, '$1');
      const currentUrl = `${location.protocol}//${location.host}`;
      const githubUrls = store
        .get(STORE.GHEURLS)
        .split(/\n/)
        .map(normalizeUrl)
        .concat('https://github.com');

      if (~githubUrls.indexOf(currentUrl)) {
        return new GitHub(store);
      }
    }

    /**
     * Invoked when the user saves the option changes in the option view.
     * @param {!string} event
     * @param {!Object<!string, [(string|boolean), (string|boolean)]>} changes
     */
    async function optionsChanged(event, changes) {
      let reload = false;

      Object.keys(changes).forEach((storeKey) => {
        const [oldKeys, newKeys] = changes[storeKey];

        switch (storeKey) {
          case STORE.TOKEN:
          case STORE.LOADALL:
          case STORE.ICONS:
          case STORE.PR:
            reload = true;
            break;
          case STORE.HOTKEYS:
            handleHotKeys(newKeys, oldKeys);
            break;
        }
      });

      if (await pluginManager.applyOptions(changes)) {
        reload = true;
      }

      if (reload) {
        tryLoadRepo(true);
      }
    }

    function tryLoadRepo(reload) {
      hasError = false;
      const token = store.get(STORE.TOKEN);
      const pinned = store.get(STORE.PINNED);

      adapter.getRepoFromPath(currRepo, token, (err, repo) => {
        if (err) {
          showError(err);
        } else if (repo) {
          $toggler.show();

          if (pinned) togglePin(true);

          if (isSidebarVisible()) {
            const replacer = ['username', 'reponame', 'branch', 'pullNumber'];
            const repoChanged = JSON.stringify(repo, replacer) !== JSON.stringify(currRepo, replacer);
            if (repoChanged || reload === true) {
              $document.trigger(EVENT.REQ_START);
              currRepo = repo;
              treeView.show(repo, token);
            } else {
              treeView.syncSelection();
            }
          }
        } else {
          $toggler.hide();
          toggleSidebar(false);
        }
        helpPopup.init();
        layoutChanged();
      });
    }

    function showView(view) {
      $views.removeClass('current');
      view.addClass('current');
    }

    function showError(err) {
      hasError = true;
      errorView.show(err);
    }

    function toggleSidebar(visibility) {
      if (visibility !== undefined) {
        if (isSidebarVisible() === visibility) return;
        toggleSidebar();
      } else {
        $html.toggleClass(SHOW_CLASS);
        $document.trigger(EVENT.TOGGLE, isSidebarVisible());
        // Load repo when the page first loaded in the layout mode
        if (isSidebarVisible()) tryLoadRepo();
      }

      return visibility;
    }

    function togglePin(isPinned) {
      if (isPinned !== undefined) {
        if (isSidebarPinned() === isPinned) return;
        return togglePin();
      }

      $pinner.toggleClass(PINNED_CLASS);
      const sidebarPinned = isSidebarPinned();
      $pinner.find('.tooltipped').attr('aria-label', `${sidebarPinned ? 'Pin' : 'Unpin'} octotree to the page`);

      $document.trigger(EVENT.PIN, sidebarPinned);

      store.set(STORE.PINNED, sidebarPinned);

      if (sidebarPinned) toggleSidebar(true);

      return sidebarPinned;
    }

    function layoutChanged(save = false) {
      const width = $sidebar.outerWidth();
      adapter.updateLayout(isSidebarPinned(), isSidebarVisible(), width);
      if (save === true) {
        store.set(STORE.WIDTH, width);
      }
    }

    /**
     * Handling auto toggle behaviours
     *  - The toggle timer starts over whenever user leave/navigate the sidebar
     *  - Clearing the toggle timer on mousemove handles the case
     *    in which mouse moves out and in the sidebard during the delay time
     *  - There is no delay when using shortkeys
     */
    function handleSidebarAutoToggling() {
      let timerId = null;

      const resetTimer = (delay) => {
        if (!isSidebarPinned()) {
          clearTimer();
          // Using isSidebarPinned as a flag to ensure the UI consistency
          timerId = setTimeout(() => toggleSidebar(isSidebarPinned()), delay);
        }
      };

      const clearTimer = () => timerId && clearTimeout(timerId);

      $sidebar.on('keyup mouseleave', () => resetTimer(SIDEBAR_HIDING_DELAY));
      $sidebar.on('mousemove', clearTimer);
      $sidebar.on(EVENT.HOTKEYS_CHANGED, () => resetTimer(0));
    }

    /**
     * Binding the Unpin/Pin hotkeys to the handler. It replaces the old hotkeys with the new ones if any
     * @param {string} newKeys
     * @param {string?} oldKeys
     */
    function handleHotKeys(newKeys, oldKeys) {
      if (oldKeys) key.unbind(oldKeys);

      key.filter = () => $toggler.is(':visible');
      key(newKeys, () => {
        togglePin() && treeView.focus();
        $sidebar.trigger(EVENT.HOTKEYS_CHANGED);
      });
    }

    function isSidebarVisible() {
      return $html.hasClass(SHOW_CLASS);
    }

    function isSidebarPinned() {
      return $pinner.hasClass(PINNED_CLASS);
    }

    function isOutsideSidebar(selector) {
      return !$(selector).closest($sidebar).length;
    }
  }
});
