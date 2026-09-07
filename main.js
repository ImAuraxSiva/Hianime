const {
    app,
    BrowserWindow,
    session,
    Menu,
    dialog
} = require('electron');

const path = require('path');
const RPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');

const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');


// =====================================================
// CONFIG
// =====================================================

const clientId = '1525225649541877892';
const HOME_URL = 'https://hianime.dk/home';

RPC.register(clientId);


// =====================================================
// GLOBALS
// =====================================================

let win = null;
let rpc = null;

let isRpcReady = false;
let rpcStarting = false;
let updateRunning = false;

let currentURL = HOME_URL;

let lastRPCKey = null;
let lastURL = null;


// =====================================================
// DEBUG
// =====================================================

process.on('uncaughtException', err => {
    console.log('Uncaught Exception:', err);
});

process.on('unhandledRejection', err => {
    console.log('Unhandled Rejection:', err);
});


// =====================================================
// AUTO UPDATER
// =====================================================

function setupAutoUpdater() {

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('Update available:', info.version);
    });

    autoUpdater.on('update-not-available', () => {
        console.log('No update available. Current version is latest.');
    });

    autoUpdater.on('error', (err) => {
        console.log('AutoUpdater error:', err);
    });

    autoUpdater.on('download-progress', (progress) => {
        console.log(`Downloading update: ${progress.percent.toFixed(1)}% (${(progress.bytesPerSecond / 1024).toFixed(1)} KB/s)`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('Update downloaded:', info.version);

        dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: `A new version (${info.version}) has been downloaded.\nRestart now to install it?`,
            buttons: ['Restart Now', 'Later']
        }).then(result => {
            if (result.response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });

    // Initial check on startup
    autoUpdater.checkForUpdates().catch(err => {
        console.log('Initial update check failed:', err);
    });

    // Recheck every 30 minutes while app is running
    setInterval(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.log('Periodic update check failed:', err);
        });
    }, 30 * 60 * 1000);

}


// =====================================================
// ADBLOCK
// =====================================================

async function setupAdblock() {
    try {
        const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
        blocker.enableBlockingInSession(session.defaultSession);
        console.log('Adblock enabled');
    } catch (err) {
        console.log('Adblock failed:', err);
    }
}


// =====================================================
// CLEAN URL
// =====================================================

function cleanURL(url) {
    if (!url) return HOME_URL;
    if (url.startsWith('about:')) return HOME_URL;
    return url.split('#')[0];
}


// =====================================================
// SET WATCHING ACTIVITY
// =====================================================

async function setWatchingActivity({
    details,
    state,
    largeImageKey,
    largeImageText,
    smallImageKey,
    smallImageText,
    startTimestamp,
    endTimestamp,
    buttons
}) {

    if (!rpc || !isRpcReady) return;

    try {
        await rpc.request('SET_ACTIVITY', {
            pid: process.pid,
            activity: {
                type: 3,
                details,
                state,
                timestamps: {
                    start: startTimestamp || undefined,
                    end: endTimestamp || undefined
                },
                assets: {
                    large_image: largeImageKey,
                    large_text: largeImageText,
                    small_image: smallImageKey,
                    small_text: smallImageText
                },
                buttons: buttons || undefined
            }
        });
    } catch (err) {
        console.log('SET_ACTIVITY error:', err);
    }

}


// =====================================================
// CLEAR ACTIVITY
// =====================================================

async function clearActivity() {

    if (!rpc || !isRpcReady) return;

    try {
        await rpc.request('SET_ACTIVITY', {
            pid: process.pid,
            activity: null
        });
    } catch (err) {
        console.log('Clear activity error:', err);
    }

}


// =====================================================
// IDLE ACTIVITY
// =====================================================

async function setIdleActivity() {

    if (!rpc || !isRpcReady) return;

    try {
        await rpc.request('SET_ACTIVITY', {
            pid: process.pid,
            activity: {
                type: 3,
                details: 'Browsing HiAnime',
                state: 'Looking for something to watch',
                assets: {
                    large_image: 'logo',
                    large_text: 'HiAnime'
                },
                buttons: [
                    { label: 'Home', url: HOME_URL }
                ]
            }
        });
    } catch (err) {
        console.log('Idle RPC error:', err);
    }

}


// =====================================================
// CREATE WINDOW
// =====================================================

function createWindow() {

    Menu.setApplicationMenu(null);

    win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Hianime',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    // =================================================
    // REMOVE MENU
    // =================================================

    Menu.setApplicationMenu(null);
    win.removeMenu();
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);
    win.setTitle('Hianime');

    // =================================================
    // PREVENT WEBSITE TITLE CHANGES
    // =================================================

    win.on('page-title-updated', event => {
        event.preventDefault();
        if (win && !win.isDestroyed()) {
            win.setTitle('Hianime');
        }
    });

    // =================================================
    // ESC = BACK
    // =================================================

    win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
            if (win && !win.isDestroyed() && win.webContents.canGoBack()) {
                event.preventDefault();
                win.webContents.goBack();
                console.log('Escape pressed, going back');
            }
        }
    });

    // =================================================
    // PAGE FINISHED LOADING
    // =================================================

    win.webContents.on('did-finish-load', () => {
        console.log('Page loaded');

        if (!win || win.isDestroyed()) return;

        win.setTitle('Hianime');
        win.setMenuBarVisibility(false);
        win.removeMenu();

        setTimeout(installRealtimeObserver, 500);
        setTimeout(() => updateRPC(true), 1500);
    });

    // =================================================
    // NORMAL NAVIGATION
    // =================================================

    win.webContents.on('did-navigate', () => {
        console.log('Navigation detected');

        if (!win || win.isDestroyed()) return;

        win.setTitle('Hianime');
        win.setMenuBarVisibility(false);
        win.removeMenu();

        setTimeout(installRealtimeObserver, 500);
        setTimeout(() => updateRPC(true), 700);
    });

    // =================================================
    // SPA NAVIGATION
    // =================================================

    win.webContents.on('did-navigate-in-page', () => {
        console.log('In-page navigation detected');

        if (!win || win.isDestroyed()) return;

        win.setTitle('Hianime');
        win.setMenuBarVisibility(false);
        win.removeMenu();

        setTimeout(installRealtimeObserver, 300);
        setTimeout(() => updateRPC(true), 500);
        setTimeout(() => updateRPC(true), 1000);
        setTimeout(() => updateRPC(true), 1800);
        setTimeout(() => updateRPC(true), 3000);
    });

    // =================================================
    // READY TO SHOW
    // =================================================

    win.once('ready-to-show', () => {
        if (!win || win.isDestroyed()) return;

        win.setTitle('Hianime');
        win.setMenuBarVisibility(false);
        win.removeMenu();
        win.show();
    });

    // =================================================
    // CLOSED
    // =================================================

    win.on('closed', () => {
        win = null;
    });

    // =================================================
    // LOAD HIANIME
    // =================================================

    win.loadURL(HOME_URL);

}


// =====================================================
// REAL-TIME HIANIME OBSERVER
// =====================================================

async function installRealtimeObserver() {

    if (!win || win.isDestroyed()) return;

    try {

        await win.webContents.executeJavaScript(`

            (() => {

                if (window.__HIANIME_RPC_OBSERVER__) {
                    return;
                }

                window.__HIANIME_RPC_OBSERVER__ = true;

                console.log('HiAnime RPC observer started');

                let lastSnapshot = '';

                function detectChange() {

                    try {

                        const video = document.querySelector('video');

                        const anime =
                            document.querySelector('.anisc-detail .title')?.innerText?.trim() ||
                            document.querySelector('.film-name')?.innerText?.trim() ||
                            document.querySelector('.film-name a')?.innerText?.trim() ||
                            document.querySelector('h1')?.innerText?.trim() ||
                            document.title?.replace(/\\s*[-|].*$/, '')?.trim() ||
                            'HiAnime';

                        let poster =
                            document.querySelector('meta[property="og:image"]')?.content ||
                            document.querySelector('.anisc-poster img')?.src ||
                            document.querySelector('.film-poster img')?.src ||
                            document.querySelector('.film-poster-img')?.src ||
                            null;

                        if (poster && poster.startsWith('/')) {
                            poster = location.origin + poster;
                        }

                        const genreLinks = document.querySelectorAll(
                            '.anisc-info-wrap a[href*="/genres/"], ' +
                            '.anisc-info a[href*="/genres/"], ' +
                            '.per-info-tag a[href*="/genres/"]'
                        );

                        const genres = genreLinks && genreLinks.length
                            ? Array.from(genreLinks)
                                .map(a => a.innerText.trim())
                                .filter(Boolean)
                                .slice(0, 3)
                                .join(', ')
                            : null;

                        const subCount =
                            document.querySelector('.tick-sub')?.innerText?.trim()?.replace(/\\D/g, '') || null;

                        const dubCount =
                            document.querySelector('.tick-dub')?.innerText?.trim()?.replace(/\\D/g, '') || null;

                        const activeEp =
                            document.querySelector('.ep-item.active') ||
                            document.querySelector('.ssl-item.ep-item.active') ||
                            document.querySelector('a[data-number].active') ||
                            document.querySelector('[data-number].active');

                        let epText = '';

                        if (activeEp) {
                            epText = activeEp.innerText?.trim() || '';
                        }

                        if (!epText) {
                            epText =
                                document.querySelector('.ep-title')?.innerText?.trim() ||
                                document.querySelector('.c-eplist .active')?.innerText?.trim() ||
                                '';
                        }

                        let episode = null;

                        if (activeEp) {
                            episode =
                                activeEp.getAttribute('data-number') ||
                                activeEp.getAttribute('data-episode') ||
                                activeEp.querySelector('.ssli-order')?.innerText?.trim() ||
                                null;
                        }

                        if (!episode && epText) {
                            const numberMatch = epText.match(/(?:Episode|Ep)?\\s*(\\d+)/i);
                            if (numberMatch) {
                                episode = numberMatch[1];
                            }
                        }

                        let episodeName = null;

                        if (activeEp) {
                            episodeName =
                                activeEp.getAttribute('data-jname') ||
                                activeEp.getAttribute('data-title') ||
                                activeEp.getAttribute('title') ||
                                activeEp.querySelector('.e-dynamic-name')?.innerText?.trim() ||
                                activeEp.querySelector('.ep-name')?.innerText?.trim() ||
                                null;
                        }

                        if (!episodeName && epText) {
                            const nameMatch = epText.match(/^\\s*\\d+\\s*[-:]?\\s*(.+)$/i);
                            if (nameMatch && nameMatch[1]) {
                                episodeName = nameMatch[1].trim();
                            }
                        }

                        const url = location.href;

                        const urlEp = url.match(/[?&]ep=([^&]+)/i);
                        const episodeId = urlEp ? urlEp[1] : null;

                        const currentTime =
                            video && Number.isFinite(video.currentTime) ? video.currentTime : 0;

                        const duration =
                            video && Number.isFinite(video.duration) ? video.duration : 0;

                        const paused = video ? video.paused : null;

                        const data = {
                            anime,
                            episode: episode ? String(episode).trim() : null,
                            episodeName: episodeName ? String(episodeName).trim() : null,
                            episodeId,
                            poster,
                            genres,
                            subCount,
                            dubCount,
                            currentTime,
                            duration,
                            paused,
                            url
                        };

                        const snapshot = JSON.stringify({
                            anime: data.anime,
                            episode: data.episode,
                            episodeName: data.episodeName,
                            episodeId: data.episodeId,
                            poster: data.poster,
                            genres: data.genres,
                            subCount: data.subCount,
                            dubCount: data.dubCount,
                            url: data.url
                        });

                        if (snapshot === lastSnapshot) {
                            return;
                        }

                        lastSnapshot = snapshot;

                        window.__HIANIME_RPC_DATA__ = data;

                        console.log(
                            'PAGE CHANGE:', data.anime,
                            '| Episode:', data.episode,
                            '| Name:', data.episodeName,
                            '| URL:', data.url
                        );

                    } catch (err) {
                        console.log('Detection error:', err);
                    }

                }

                const observer = new MutationObserver(() => {
                    detectChange();
                });

                observer.observe(document.documentElement, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: ['class', 'title', 'data-number', 'data-jname', 'data-title']
                });

                let lastPageURL = location.href;

                setInterval(() => {
                    const newURL = location.href;

                    if (newURL !== lastPageURL) {
                        console.log('URL changed:', newURL);

                        lastPageURL = newURL;
                        lastSnapshot = '';

                        detectChange();

                        setTimeout(detectChange, 100);
                        setTimeout(detectChange, 300);
                        setTimeout(detectChange, 700);
                        setTimeout(detectChange, 1200);
                    }
                }, 100);

                const originalPushState = history.pushState;

                history.pushState = function() {
                    const result = originalPushState.apply(this, arguments);
                    lastSnapshot = '';
                    setTimeout(detectChange, 100);
                    return result;
                };

                const originalReplaceState = history.replaceState;

                history.replaceState = function() {
                    const result = originalReplaceState.apply(this, arguments);
                    lastSnapshot = '';
                    setTimeout(detectChange, 100);
                    return result;
                };

                window.addEventListener('popstate', () => {
                    lastSnapshot = '';
                    detectChange();
                });

                function attachVideoEvents() {
                    const video = document.querySelector('video');

                    if (!video) return;
                    if (video.__HIANIME_RPC_EVENTS__) return;

                    video.__HIANIME_RPC_EVENTS__ = true;

                    video.addEventListener('loadedmetadata', detectChange);
                    video.addEventListener('durationchange', detectChange);
                }

                detectChange();

                setInterval(attachVideoEvents, 500);

                setTimeout(detectChange, 500);
                setTimeout(detectChange, 1500);
                setTimeout(detectChange, 3000);

                console.log('Real-time monitoring active');

            })();

        `);

    } catch (err) {
        console.log('Observer installation failed:', err);
    }

}


// =====================================================
// GET PAGE DATA
// =====================================================

async function getPageData() {

    if (!win || win.isDestroyed()) return null;

    try {

        return await win.webContents.executeJavaScript(`

            (() => {

                const video = document.querySelector('video');
                const stored = window.__HIANIME_RPC_DATA__;

                if (stored) {
                    return {
                        ...stored,
                        currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
                        duration: video && Number.isFinite(video.duration) ? video.duration : 0,
                        paused: video ? video.paused : null,
                        url: location.href
                    };
                }

                const anime =
                    document.querySelector('.anisc-detail .title')?.innerText?.trim() ||
                    document.querySelector('.film-name')?.innerText?.trim() ||
                    document.querySelector('.film-name a')?.innerText?.trim() ||
                    document.querySelector('h1')?.innerText?.trim() ||
                    'HiAnime';

                let poster =
                    document.querySelector('meta[property="og:image"]')?.content ||
                    document.querySelector('.anisc-poster img')?.src ||
                    document.querySelector('.film-poster img')?.src ||
                    null;

                if (poster && poster.startsWith('/')) {
                    poster = location.origin + poster;
                }

                const genreLinks = document.querySelectorAll(
                    '.anisc-info-wrap a[href*="/genres/"], ' +
                    '.anisc-info a[href*="/genres/"], ' +
                    '.per-info-tag a[href*="/genres/"]'
                );

                const genres = genreLinks && genreLinks.length
                    ? Array.from(genreLinks)
                        .map(a => a.innerText.trim())
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(', ')
                    : null;

                const subCount =
                    document.querySelector('.tick-sub')?.innerText?.trim()?.replace(/\\D/g, '') || null;

                const dubCount =
                    document.querySelector('.tick-dub')?.innerText?.trim()?.replace(/\\D/g, '') || null;

                const activeEp =
                    document.querySelector('.ep-item.active') ||
                    document.querySelector('.ssl-item.ep-item.active') ||
                    document.querySelector('a[data-number].active') ||
                    document.querySelector('[data-number].active');

                const epText =
                    activeEp?.innerText?.trim() ||
                    document.querySelector('.ep-title')?.innerText?.trim() ||
                    '';

                let episode = null;

                if (activeEp) {
                    episode =
                        activeEp.getAttribute('data-number') ||
                        activeEp.getAttribute('data-episode') ||
                        activeEp.querySelector('.ssli-order')?.innerText?.trim() ||
                        null;
                }

                if (!episode && epText) {
                    const numberMatch = epText.match(/(?:Episode|Ep)?\\s*(\\d+)/i);
                    if (numberMatch) {
                        episode = numberMatch[1];
                    }
                }

                let episodeName = null;

                if (activeEp) {
                    episodeName =
                        activeEp.getAttribute('data-jname') ||
                        activeEp.getAttribute('data-title') ||
                        activeEp.getAttribute('title') ||
                        activeEp.querySelector('.e-dynamic-name')?.innerText?.trim() ||
                        activeEp.querySelector('.ep-name')?.innerText?.trim() ||
                        null;
                }

                if (!episodeName && epText) {
                    const nameMatch = epText.match(/^\\s*\\d+\\s*[-:]?\\s*(.+)$/i);
                    if (nameMatch && nameMatch[1]) {
                        episodeName = nameMatch[1].trim();
                    }
                }

                return {
                    anime,
                    episode: episode ? String(episode).trim() : null,
                    episodeName: episodeName ? String(episodeName).trim() : null,
                    poster,
                    genres,
                    subCount,
                    dubCount,
                    currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
                    duration: video && Number.isFinite(video.duration) ? video.duration : 0,
                    paused: video ? video.paused : null,
                    url: location.href
                };

            })();

        `);

    } catch (err) {
        console.log('getPageData error:', err);
        return null;
    }

}


// =====================================================
// UPDATE RPC
// =====================================================

async function updateRPC(force = false) {

    if (updateRunning) return;
    if (!win || win.isDestroyed()) return;

    if (!isRpcReady || !rpc) {
        console.log('RPC update skipped - RPC not ready');
        return;
    }

    updateRunning = true;

    try {

        const data = await getPageData();

        if (!data) return;

        currentURL = cleanURL(data.url);

        const isWatchingPage = currentURL.includes('/watch/');

        if (!isWatchingPage) {

            const idleKey = 'idle:' + currentURL;

            if (!force && idleKey === lastRPCKey) {
                return;
            }

            lastRPCKey = idleKey;
            lastURL = currentURL;

            await setIdleActivity();

            console.log('Discord RPC updated (Browsing)');

            return;
        }

        const anime = String(data.anime || 'HiAnime').trim();

        const episode = data.episode ? String(data.episode).trim() : null;

        const episodeName = data.episodeName ? String(data.episodeName).trim() : null;

        const isPlaying = data.paused !== true;

        let episodeDisplay = 'Watching';

        if (episode) {
            episodeDisplay = `Episode ${episode}`;
        }

        if (episode && episodeName) {
            episodeDisplay = `Episode ${episode} - ${episodeName}`;
        }

        const poster = data.poster || 'logo';

        const tooltipParts = [anime];

        if (data.genres) {
            tooltipParts.push(data.genres);
        }

        if (data.subCount || data.dubCount) {
            const counts = [];

            if (data.subCount) counts.push(`Sub ${data.subCount}`);
            if (data.dubCount) counts.push(`Dub ${data.dubCount}`);

            tooltipParts.push(counts.join(' / '));
        }

        const largeImageText = tooltipParts.join(' • ').slice(0, 128);

        let startTimestamp;
        let endTimestamp;

        if (isPlaying && data.duration > 0) {
            const now = Math.floor(Date.now() / 1000);

            startTimestamp = now - Math.floor(data.currentTime);
            endTimestamp = startTimestamp + Math.floor(data.duration);
        }

        const rpcKey = JSON.stringify({
            url: currentURL,
            anime,
            episode,
            episodeName,
            isPlaying,
            poster,
            largeImageText
        });

        if (!force && rpcKey === lastRPCKey) {
            return;
        }

        lastRPCKey = rpcKey;
        lastURL = currentURL;

        console.log('');
        console.log('================================');
        console.log('RPC UPDATE');
        console.log('================================');
        console.log('Forced:', force);
        console.log('Anime:', anime);
        console.log('Episode:', episode);
        console.log('Episode Name:', episodeName);
        console.log('URL:', currentURL);
        console.log('Playing:', isPlaying);
        console.log('Current Time:', data.currentTime);
        console.log('Duration:', data.duration);
        console.log('Poster:', poster);
        console.log('Tooltip:', largeImageText);

        await setWatchingActivity({
            details: anime,
            state: isPlaying ? episodeDisplay : `Paused - ${episodeDisplay}`,
            largeImageKey: poster,
            largeImageText: largeImageText,
            smallImageKey: isPlaying ? 'play' : 'pause',
            smallImageText: isPlaying ? 'Watching' : 'Paused',
            startTimestamp,
            endTimestamp,
            buttons: [
                { label: 'Home', url: HOME_URL },
                { label: 'Watch', url: currentURL }
            ]
        });

        console.log('Discord RPC updated successfully');
        console.log('================================');

    } catch (err) {
        console.log('RPC update error:', err);
    } finally {
        updateRunning = false;
    }

}


// =====================================================
// START DISCORD RPC
// =====================================================

function startRPC() {

    if (rpc || rpcStarting) return;

    rpcStarting = true;

    console.log('Starting Discord RPC...');

    rpc = new RPC.Client({ transport: 'ipc' });

    rpc.on('ready', async () => {

        console.log('RPC Connected');

        isRpcReady = true;
        rpcStarting = false;
        lastRPCKey = null;

        try {

            await setWatchingActivity({
                details: 'HiAnime',
                state: 'Watching',
                largeImageKey: 'logo',
                largeImageText: 'HiAnime',
                smallImageKey: 'play',
                smallImageText: 'Watching',
                buttons: [
                    { label: 'Home', url: HOME_URL }
                ]
            });

            console.log('Initial Watching RPC set');

        } catch (err) {
            console.log('Initial RPC error:', err);
        }

        setTimeout(() => {
            updateRPC(true);
        }, 1500);

    });

    rpc.on('error', err => {
        console.log('RPC Error:', err);
    });

    rpc.on('disconnected', () => {

        console.log('Discord RPC disconnected');

        isRpcReady = false;
        rpcStarting = false;

        if (rpc) {
            try {
                rpc.destroy();
            } catch (err) {
                console.log('RPC destroy error:', err);
            }
        }

        rpc = null;
        lastRPCKey = null;

        setTimeout(startRPC, 3000);

    });

    rpc.login({ clientId }).catch(err => {

        console.log('RPC Login Failed:', err.message);

        isRpcReady = false;
        rpcStarting = false;

        if (rpc) {
            try {
                rpc.destroy();
            } catch (destroyError) {
                console.log('RPC destroy error:', destroyError);
            }
        }

        rpc = null;
        lastRPCKey = null;

        setTimeout(startRPC, 3000);

    });

}


// =====================================================
// URL MONITOR
// =====================================================

function startURLMonitor() {

    console.log('URL monitor started');

    setInterval(() => {

        if (!win || win.isDestroyed()) return;

        try {

            const url = win.webContents.getURL();
            const cleaned = cleanURL(url);

            if (lastURL === null) {

                lastURL = cleaned;
                currentURL = cleaned;

                console.log('Initial URL:', cleaned);

                setTimeout(() => updateRPC(true), 1500);

                return;
            }

            if (cleaned !== lastURL) {

                console.log('');
                console.log('URL CHANGE DETECTED');
                console.log('OLD:', lastURL);
                console.log('NEW:', cleaned);

                currentURL = cleaned;
                lastURL = cleaned;

                setTimeout(() => updateRPC(true), 500);
                setTimeout(() => updateRPC(true), 1000);
                setTimeout(() => updateRPC(true), 1800);
                setTimeout(() => updateRPC(true), 3000);

            }

        } catch (err) {
            console.log('URL monitor error:', err);
        }

    }, 100);

}


// =====================================================
// PERIODIC RPC CHECK
// =====================================================

function startRPCMonitor() {

    console.log('RPC monitor started');

    setInterval(() => {

        if (!win || win.isDestroyed()) return;
        if (!rpc || !isRpcReady) return;

        updateRPC(false);

    }, 2000);

}


// =====================================================
// APP READY
// =====================================================

app.whenReady().then(async () => {

    console.log('');
    console.log('================================');
    console.log('Starting HiAnime RPC');
    console.log('================================');

    await setupAdblock();

    createWindow();

    startRPC();
    startURLMonitor();
    startRPCMonitor();

    setupAutoUpdater();

});


// =====================================================
// WINDOWS CLOSED
// =====================================================

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});


// =====================================================
// BEFORE QUIT
// =====================================================

app.on('before-quit', async () => {
    try {
        if (rpc && isRpcReady) {
            await clearActivity();
            console.log('RPC cleared');
        }
    } catch (err) {
        console.log('RPC clear error:', err);
    }
});


// =====================================================
// MACOS
// =====================================================

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});