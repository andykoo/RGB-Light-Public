/** Config.gs - Wrapper for System SystemConfig */

/**
 * Get config value by key
 * @param {string} key
 * @param {string} defaultValue
 * @return {string}
 */
function Config_get(key, defaultValue = '') {
  // Try DB first
  const dbValue = db_getSystemConfig_(key);
  if (dbValue !== null && dbValue !== '') {
    return dbValue;
  }
  
  // Fallback to ScriptProperties (Migration support)
  // Once migrated, you can remove this fallback if desired.
  const props = PropertiesService.getScriptProperties();
  const propValue = props.getProperty(key);
  if (propValue) return propValue;
  
  return defaultValue;
}

/**
 * Set config value
 * @param {string} key
 * @param {string} value
 */
function Config_set(key, value) {
  db_setSystemConfig_(key, value);
}

/**
 * Get all configs as object
 */
function Config_getAll() {
  return db_getAllSystemConfigs_();
}
