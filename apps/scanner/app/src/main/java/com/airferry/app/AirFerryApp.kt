package com.airferry.app

import android.app.Application
import com.airferry.app.scan.CacheCleanup
import com.airferry.app.scan.ContentStore

/**
 * Process-wide startup: migrate legacy received/ once, then purge orphaned cache.
 */
class AirFerryApp : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            ContentStore.migrateLegacyReceivedIfNeeded(this)
        } catch (_: Exception) {
            // Non-fatal: list will simply be empty until next receive.
        }
        CacheCleanup.purgeOnAppStart(this)
    }
}
