const GH_RESERVED_USER_NAMES = [
  'settings', 'orgs', 'organizations',
  'site', 'blog', 'about', 'explore',
  'styleguide', 'showcases', 'trending',
  'stars', 'dashboard', 'notifications',
  'search', 'developer', 'account',
  'pulls', 'issues', 'features', 'contact',
  'security', 'join', 'login', 'watching',
  'new', 'integrations', 'gist', 'business',
  'mirrors', 'open-source', 'personal',
  'pricing'
]
const GH_RESERVED_REPO_NAMES = ['followers', 'following', 'repositories']
const GH_404_SEL = '#parallax_wrapper'
const GH_PJAX_CONTAINER_SEL = '#js-repo-pjax-container, .context-loader-container, [data-pjax-container]'
const GH_CONTAINERS = '.container, .container-responsive'
const GH_RAW_CONTENT = 'body > pre'

class GitHub extends PjaxAdapter {

  constructor() {
    super(['jquery.pjax.js'])
  }

  // @override
  init($sidebar) {
    const pjaxContainer = $(GH_PJAX_CONTAINER_SEL)[0]
    super.init($sidebar, {'pjaxContainer': pjaxContainer})

    // Fix #151 by detecting when page layout is updated.
    // In this case, split-diff page has a wider layout, so need to recompute margin.
    // Note that couldn't do this in response to URL change, since new DOM via pjax might not be ready.
    const diffModeObserver = new window.MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (~mutation.oldValue.indexOf('split-diff') ||
            ~mutation.target.className.indexOf('split-diff')) {
          return $(document).trigger(EVENT.LAYOUT_CHANGE)
        }
      })
    })

    diffModeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true
    })
  }

  // @override
  getCssClass() {
    return 'octotree_github_sidebar'
  }

  // @override
  canLoadEntireTree() {
    return true
  }

  // @override
  getCreateTokenUrl() {
    return `${location.protocol}//${location.host}/settings/tokens/new`
  }

  // @override
  updateLayout(togglerVisible, sidebarVisible, sidebarWidth) {
    const SPACING = 10
    const $containers = $(GH_CONTAINERS)
    const autoMarginLeft = ($(document).width() - $containers.width()) / 2
    const shouldPushLeft = sidebarVisible && (autoMarginLeft <= sidebarWidth + SPACING)

    $('html').css('margin-left', shouldPushLeft ? sidebarWidth : '')
    $containers.css('margin-left', shouldPushLeft ? SPACING : '')
  }

  // @override
  getRepoFromPath(showInNonCodePage, currentRepo, token, cb) {

    // 404 page, skip
    if ($(GH_404_SEL).length) {
      return cb()
    }

    // Skip raw page
    if ($(GH_RAW_CONTENT).length) {
      return cb()
    }

    // (username)/(reponame)[/(type)][/(typeId)]
    const match = window.location.pathname.match(/([^\/]+)\/([^\/]+)(?:\/([^\/]+))?(?:\/([^\/]+))?/)
    if (!match) {
      return cb()
    }

    let username = match[1]
    let reponame = match[2]
    let type = match[3]

    // Not a repository, skip
    if (~GH_RESERVED_USER_NAMES.indexOf(username) ||
        ~GH_RESERVED_REPO_NAMES.indexOf(reponame)) {
      return cb()
    }

    // TODO: Add option for toggling PR view
    // Skip non-code page unless showInNonCodePage is true
    if (!showInNonCodePage && type && !~['tree', 'blob', 'pull'].indexOf(type)) {
      return cb()
    }

    // Get branch by inspecting page, quite fragile so provide multiple fallbacks
    const branch =
      // Code page
      $('.branch-select-menu .select-menu-item.selected').data('name') ||
      // Pull requests page
      ($('.commit-ref.base-ref').attr('title') || ':').match(/:(.*)/)[1] ||
      // Reuse last selected branch if exist
      (currentRepo.username === username && currentRepo.reponame === reponame && currentRepo.branch) ||
      // Get default branch from cache
      this._defaultBranch[username + '/' + reponame]

    // Check if this is a PR
    const isPR = type === 'pull';
    const pull = isPR ? match[4] : null;

    // Still no luck, get default branch for real
    const repo = {username: username, reponame: reponame, branch: branch, pull: pull}
    if (repo.branch) {
      cb(null, repo)
    }
    else {
      this._get(null, {repo, token}, (err, data) => {
        if (err) return cb(err)
        repo.branch = this._defaultBranch[username + '/' + reponame] = data.default_branch || 'master'
        cb(null, repo)
      })
    }
  }

  // @override
  selectFile(path) {
    const $pjaxContainer = $(GH_PJAX_CONTAINER_SEL)
    super.selectFile(path, {'$pjaxContainer': $pjaxContainer})
  }

  // @override
  loadCodeTree(opts, cb) {
    opts.encodedBranch = encodeURIComponent(decodeURIComponent(opts.repo.branch))
    opts.path = (opts.node && (opts.node.sha || opts.encodedBranch)) ||
                (opts.encodedBranch + '?recursive=1')
    this._loadCodeTree(opts, null, cb)
  }

  // @override
  _getTree(path, opts, cb) {
    this._get(`/git/trees/${path}`, opts, (err, res) => {
      if (err) cb(err)
      else {
        if (!opts.repo.pull) cb(null, res.tree)
        else {
          this._getPatch(opts, (patchErr, patchRes) => {
            const diffExists = patchRes && Object.keys(patchRes).length > 0
            if(patchErr || !diffExists) cb(null, res.tree)
            else {
              // Filter tree to only include files and directories that are included in the patch
              const filteredTree = res.tree
                  .filter((node) => {
                    return patchRes[node.path] !== undefined
                  })
                  .map((node) => {
                    const patch = patchRes[node.path]
                    node.patch = typeof patch === 'object' ? patch : undefined
                    return node
                  })
              cb(null, filteredTree)
            }
          })
        }
      }
    })
  }

  /**
   * Get files that were patched in Pull Request.
   * The diff map that is returned contains changed files, as well as the parents of the changed files.
   * This allows the tree to be filtered for only folders that contain files with diffs.
   * @param {Object} opts: {
   *                  path: the starting path to load the tree,
   *                  repo: the current repository,
   *                  node (optional): the selected node (null to load entire tree),
   *                  token (optional): the personal access token
   *                 }
   * @param {Function} cb(err: error, diffMap: Object)
   */
   _getPatch(opts, cb) {
    const {pull} = opts.repo
    this._get(`/pulls/${pull}/files`, opts, (err, res) => {
      if (err) cb(err)
      else {
        const diffMap = {}
        res.forEach(file => {
          // Grab parent folder path
          const folderPath = file.filename.split('/').slice(0,-1).join('/')
          // Record file patch info
          diffMap[file.filename] = {
            action: file.status,
            additions: file.additions,
            deletions: file.deletions,
            filename: file.filename,
            path: file.path,
            sha: file.sha,
          }
          // Record ancestor folder patch info
          const split = folderPath.split('/')
          split.reduce((path, curr) => {
            if (path.length) {
              path = `${path}/${curr}`
            }
            else {
              path = `${curr}`
            }
            // Either the current path contains children with diffs
            // or assign it true so that it's included in
            // the filtered tree
            if (typeof diffMap[path] === 'object') {
              // Path already has been recorded, accumulate changes
              diffMap[path].additions += file.additions
              diffMap[path].deletions += file.deletions
              diffMap[path].changes++
            }
            else {
              diffMap[path] = {
                additions: file.additions,
                deletions: file.deletions,
                changes: 1,
              }
            }
            return path
          }, '')
        })
        cb(null, diffMap);
      }
    })
   }

  // @override
  _getSubmodules(tree, opts, cb) {
    const item = tree.filter((item) => /^\.gitmodules$/i.test(item.path))[0]
    if (!item) return cb()

    this._get(`/git/blobs/${item.sha}`, opts, (err, res) => {
      if (err) return cb(err)
      const data = atob(res.content.replace(/\n/g,''))
      cb(null, parseGitmodules(data))
    })
  }

  _get(path, opts, cb) {
    const host = location.protocol + '//' +
      (location.host === 'github.com' ? 'api.github.com' : (location.host + '/api/v3'))
    const url = `${host}/repos/${opts.repo.username}/${opts.repo.reponame}${path || ''}`
    const cfg  = { url, method: 'GET', cache: false }

    if (opts.token) {
      cfg.headers = { Authorization: 'token ' + opts.token }
    }

    $.ajax(cfg)
      .done((data) => {
        if (path && path.indexOf('/git/trees') === 0 && data.truncated) {
          this._handleError({status: 206}, cb)
        }
        else cb(null, data)
      })
      .fail((jqXHR) => this._handleError(jqXHR, cb))
  }
}
