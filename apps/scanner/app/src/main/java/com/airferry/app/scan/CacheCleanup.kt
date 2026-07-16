package com.airferry.app.scan

import android.content.Context
import android.util.Log
import java.io.File

/**
 * App-cache housekeeping for **legacy** recovery temps and share staging.
 *
 * Modern transfers use [ContentStore] under `files/store/` (not purged here).
 * This only cleans leftover `cacheDir/recovered_*` and `cacheDir/share/` from
 * older builds or interrupted sessions.
 */
object CacheCleanup {

    private const val TAG = "CacheCleanup"
    private const val PREFS = "airferry_cache"
    private const val KEY_SHARE_DIRTY = "share_dirty"
    private const val SHARE_DIR = "share"
    private const val RECOVERED_PREFIX = "recovered_"

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
        } catch (e: Exception) {
            Log.w(TAG, "purgeOnAppStart failed", e)
        }
        if (removed > 0) {
            Log.i(TAG, "purged $removed legacy cache entr(y/ies)")
        }
    }
}
