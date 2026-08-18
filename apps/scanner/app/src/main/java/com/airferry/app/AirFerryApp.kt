package com.airferry.app

import android.app.Application
import com.airferry.app.scan.CacheCleanup
import com.airferry.app.scan.ContentStore

/**
 * Process-wide startup: migrate legacy received/ once, then purge orphaned cache.
 *
 * Both steps do real disk IO (the legacy migration even reads whole files and
 * hashes them) — running them on the main thread ANR-risks app start when the
 * legacy tree is large, and neither needs to finish before the first frame.
 * ContentStore's store-level @Synchronized keeps the background migration
 * ordered against any UI-driven store access.
 */
class AirFerryApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Thread {
            try {
                ContentStore.migrateLegacyReceivedIfNeeded(this)
            } catch (_: Exception) {
                // Non-fatal: list will simply be empty until next receive.
            }
            CacheCleanup.purgeOnAppStart(this)
        }.apply {
            name = "af2-startup-maintenance"
            isDaemon = true
        }.start()
    }
}
