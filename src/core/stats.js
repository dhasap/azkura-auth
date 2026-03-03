/**
 * Statistics & Analytics module for Azkura Auth
 * Tracks usage patterns, calculates security scores, and generates insights
 */

import { getLocalItem, setLocalItem } from './storage.js';

const STATS_KEY = 'appStats';
const MAX_DAILY_HISTORY = 30; // Keep 30 days of activity data

/**
 * Get or initialize stats object
 * @returns {Promise<object>}
 */
async function getStats() {
  const stats = await getLocalItem(STATS_KEY);
  if (!stats) {
    return {
      copyCounts: {},
      dailyActivity: {},
      lastBackupAt: null,
      firstAccountCreatedAt: null,
      totalCopies: 0,
      lastCopyAt: null
    };
  }
  return stats;
}

/**
 * Save stats to storage
 * @param {object} stats
 */
async function saveStats(stats) {
  await setLocalItem(STATS_KEY, stats);
}

/**
 * Get today's date string (YYYY-MM-DD)
 * @returns {string}
 */
function getTodayString() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Track when user copies a code
 * @param {string} accountId
 */
export async function trackAccountCopy(accountId) {
  const stats = await getStats();
  const today = getTodayString();
  
  // Increment copy count for this account
  if (!stats.copyCounts[accountId]) {
    stats.copyCounts[accountId] = 0;
  }
  stats.copyCounts[accountId]++;
  
  // Increment daily activity
  if (!stats.dailyActivity[today]) {
    stats.dailyActivity[today] = 0;
  }
  stats.dailyActivity[today]++;
  
  // Update totals
  stats.totalCopies++;
  stats.lastCopyAt = new Date().toISOString();
  
  // Cleanup old daily activity data
  cleanupOldActivity(stats);
  
  await saveStats(stats);
}

/**
 * Track backup event
 */
export async function trackBackup() {
  const stats = await getStats();
  stats.lastBackupAt = new Date().toISOString();
  await saveStats(stats);
}

/**
 * Track first account creation
 */
export async function trackFirstAccount() {
  const stats = await getStats();
  if (!stats.firstAccountCreatedAt) {
    stats.firstAccountCreatedAt = new Date().toISOString();
    await saveStats(stats);
  }
}

/**
 * Remove daily activity older than MAX_DAILY_HISTORY days
 * @param {object} stats
 */
function cleanupOldActivity(stats) {
  const today = new Date();
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() - MAX_DAILY_HISTORY);
  
  const filtered = {};
  for (const [date, count] of Object.entries(stats.dailyActivity)) {
    if (new Date(date) >= cutoffDate) {
      filtered[date] = count;
    }
  }
  stats.dailyActivity = filtered;
}

/**
 * Get top N most used accounts
 * @param {Array} accounts
 * @param {number} n
 * @returns {Promise<Array>}
 */
export async function getMostUsedAccounts(accounts, n = 3) {
  const stats = await getStats();
  
  return accounts
    .map(acc => ({
      ...acc,
      copyCount: stats.copyCounts[acc.id] || 0
    }))
    .sort((a, b) => b.copyCount - a.copyCount)
    .slice(0, n)
    .filter(acc => acc.copyCount > 0);
}

/**
 * Get service distribution
 * @param {Array} accounts
 * @returns {Array}
 */
export function getServiceDistribution(accounts) {
  const distribution = {};
  
  accounts.forEach(acc => {
    const service = acc.issuer || 'Unknown';
    if (!distribution[service]) {
      distribution[service] = 0;
    }
    distribution[service]++;
  });
  
  // Convert to array and sort by count
  const sorted = Object.entries(distribution)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  
  // Group smaller ones as "Others" if more than 5 services
  if (sorted.length > 5) {
    const top5 = sorted.slice(0, 5);
    const others = sorted.slice(5);
    const othersCount = others.reduce((sum, s) => sum + s.count, 0);
    return [...top5, { name: 'Others', count: othersCount }];
  }
  
  return sorted;
}

/**
 * Get weekly activity (last 7 days)
 * @returns {Promise<Array>}
 */
export async function getWeeklyActivity() {
  const stats = await getStats();
  const result = [];
  
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    
    result.push({
      day: dayName,
      date: dateStr,
      count: stats.dailyActivity[dateStr] || 0
    });
  }
  
  return result;
}

/**
 * Calculate security score (0-100)
 * @param {object} options
 * @returns {Promise<number>}
 */
export async function calculateSecurityScore(options = {}) {
  const { 
    hasPin, 
    pinEnabled, 
    hasGoogleBackup, 
    hasLocalBackup,
    accountCount,
    hasFolders
  } = options;
  
  let score = 0;
  
  // PIN Protection (40 points)
  if (hasPin && pinEnabled) {
    score += 40;
  } else if (hasPin && !pinEnabled) {
    score += 20; // Partial credit for having PIN setup but disabled
  }
  
  // Backup (30 points)
  if (hasGoogleBackup) {
    score += 20;
  }
  if (hasLocalBackup) {
    score += 10;
  }
  
  // Organization (20 points)
  if (hasFolders) {
    score += 10;
  }
  if (accountCount > 0 && accountCount <= 20) {
    score += 10; // Good account count
  } else if (accountCount > 20) {
    score += 5; // Many accounts, harder to manage
  }
  
  // Recent backup (10 points)
  const stats = await getStats();
  if (stats.lastBackupAt) {
    const lastBackup = new Date(stats.lastBackupAt);
    const daysSinceBackup = (Date.now() - lastBackup.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceBackup < 1) {
      score += 10; // Backed up today
    } else if (daysSinceBackup < 7) {
      score += 7; // Backed up this week
    } else if (daysSinceBackup < 30) {
      score += 3; // Backed up this month
    }
  }
  
  return Math.min(100, Math.max(0, score));
}

/**
 * Get security status text and color
 * @param {number} score
 * @returns {object}
 */
export function getSecurityStatus(score) {
  if (score >= 80) {
    return { text: 'Secure', color: '#30D158', icon: '🔒' };
  } else if (score >= 50) {
    return { text: 'Good', color: '#FFD60A', icon: '🛡️' };
  } else {
    return { text: 'At Risk', color: '#FF3B3B', icon: '⚠️' };
  }
}

/**
 * Get time ago text
 * @param {string} dateString
 * @returns {string}
 */
export function getTimeAgo(dateString) {
  if (!dateString) return 'Never';
  
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
  
  return `${Math.floor(seconds / 2592000)}mo ago`;
}

/**
 * Get folder distribution
 * @param {Array} accounts
 * @param {Array} folders
 * @returns {Array}
 */
export function getFolderDistribution(accounts, folders) {
  const distribution = [];
  
  // Count uncategorized
  const uncategorizedCount = accounts.filter(acc => !acc.folderId).length;
  if (uncategorizedCount > 0) {
    distribution.push({
      name: 'Uncategorized',
      count: uncategorizedCount,
      color: '#6C6C6C'
    });
  }
  
  // Count per folder
  folders.forEach(folder => {
    const count = accounts.filter(acc => acc.folderId === folder.id).length;
    if (count > 0) {
      distribution.push({
        name: folder.name,
        count,
        color: folder.color
      });
    }
  });
  
  return distribution.sort((a, b) => b.count - a.count);
}

/**
 * Get all stats for dashboard
 * @param {Array} accounts
 * @param {Array} folders
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function getDashboardStats(accounts, folders, options = {}) {
  const stats = await getStats();
  const serviceDistribution = getServiceDistribution(accounts);
  const weeklyActivity = await getWeeklyActivity();
  const mostUsed = await getMostUsedAccounts(accounts, 3);
  const folderDistribution = getFolderDistribution(accounts, folders);
  
  const securityScore = await calculateSecurityScore({
    hasPin: options.hasPin,
    pinEnabled: options.pinEnabled,
    hasGoogleBackup: options.hasGoogleBackup,
    hasLocalBackup: !!stats.lastBackupAt,
    accountCount: accounts.length,
    hasFolders: folders.length > 0
  });
  
  const securityStatus = getSecurityStatus(securityScore);
  
  return {
    totalAccounts: accounts.length,
    totalFolders: folders.length,
    securityScore,
    securityStatus,
    lastBackup: stats.lastBackupAt,
    lastBackupAgo: getTimeAgo(stats.lastBackupAt),
    totalCopies: stats.totalCopies,
    lastCopyAgo: getTimeAgo(stats.lastCopyAt),
    firstAccountAgo: getTimeAgo(stats.firstAccountCreatedAt),
    serviceDistribution,
    weeklyActivity,
    mostUsed,
    folderDistribution,
    topService: serviceDistribution[0] || null
  };
}

/**
 * Reset all stats (for data wipe)
 */
export async function resetStats() {
  await setLocalItem(STATS_KEY, {
    copyCounts: {},
    dailyActivity: {},
    lastBackupAt: null,
    firstAccountCreatedAt: null,
    totalCopies: 0,
    lastCopyAt: null
  });
}
