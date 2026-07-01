// Drizzle ORM table definitions for the API metadata database (PostgreSQL)

import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ============================================
// Users
// ============================================

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ============================================
// Projects
// ============================================

export const projects = pgTable(
  'projects',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_project_name_idx').on(table.userId, table.name)]
)

// ============================================
// Uploaded Files
// ============================================

export const uploadedFiles = pgTable('uploaded_files', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  originalFilename: text('original_filename').notNull(),
  storedFilename: text('stored_filename').notNull(),
  filePath: text('file_path').notNull(),
  fileType: text('file_type').notNull(),
  fileSize: integer('file_size').notNull(),
  sha256Hash: text('sha256_hash'),
  indexingStatus: text('indexing_status').notNull().default('pending'),
  chunkCount: integer('chunk_count').notNull().default(0),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }),
})

// ============================================
// Index Jobs
// ============================================

export const indexJobs = pgTable('index_jobs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  status: text('status').notNull().default('pending'),
  filesProcessed: integer('files_processed').notNull().default(0),
  chunksCreated: integer('chunks_created').notNull().default(0),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

// ============================================
// User Settings (embedding provider config)
// ============================================

export const userSettings = pgTable(
  'user_settings',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    embeddingProvider: text('embedding_provider').notNull().default('local'),
    apiBaseUrl: text('api_base_url'),
    apiKeyEncrypted: text('api_key_encrypted'),
    modelName: text('model_name'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_settings_user_id_idx').on(table.userId)]
)
