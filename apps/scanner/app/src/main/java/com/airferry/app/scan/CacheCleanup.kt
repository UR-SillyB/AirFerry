package com.airferry.app.scan

import android.content.Context
import android.util.Log
import java.io.File

/**
 * App-cache housekeeping for **legacy** recovery temps and share staging.
 *
 * Modern transfers use [ContentStore] under `files/store/` (not purged here).
 * This cleans leftover `cacheDir/recovered_*`, `cacheDir/share/` from older
 * builds, and `cacheDir/af2-entry-stage/` temps from interrupted stagings.
 */
object CacheCleanup {

    private const val TAG = "CacheCleanup"
    private const val PREFS = "airferry_cache"
    private const val KEY_SHARE_DIRTY = "share_dirty"
    private const val SHARE_DIR = "share"
    private const val RECOVERED_PREFIX = "recovered_"
    private const val ENTRY_STAGE_DIR = "af2-entry-stage"

    /** Optional: mark that a legacy share staging dir was used. */
    fun markShareDirty(context: Context) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_SHARE_DIRTY, true)
            .apply()
    }

    fun purgeOnAppStart(context: Context) {
        val app = context.applicationContext
        val cache = app.cacheDir ?: return
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val shareDirty = prefs.getBoolean(KEY_SHARE_DIRTY, false)

        var removed = 0
        try {
            cache.listFiles()?.forEach { f ->
                if (f.name.startsWith(RECOVERED_PREFIX)) {
                    if (f.deleteRecursively()) removed++
                }
            }
            // Always try to clear share/ if present (legacy staging).
            val share = File(cache, SHARE_DIR)
            if (share.exists() && (shareDirty || (share.list()?.isNotEmpty() == true))) {
                if (share.deleteRecursively()) removed++
            }
            if (shareDirty) {
                prefs.edit().putBoolean(KEY_SHARE_DIRTY, false).apply()
            }
            // Interrupted §13 entry staging leaves `<uuid>.partial` temps
            // behind; recovery wipes the dir at its own start, this covers
            // a process kill before that ever runs.
            val entryStage = File(cache, ENTRY_STAGE_DIR)
            if (entryStage.exists() && entryStage.listFiles()?.isNotEmpty() == true) {
                if (entryStage.deleteRecursively()) removed++
            }
        } catch (e: Exception) {
            Log.w(TAG, "purgeOnAppStart failed", e)
        }
        if (removed > 0) {
            Log.i(TAG, "purged $removed legacy cache entr(y/ies)")
        }
    }
}
