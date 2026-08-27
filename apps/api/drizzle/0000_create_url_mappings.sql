CREATE TABLE "url_mappings" (
	"short_code" varchar(32) PRIMARY KEY NOT NULL,
	"long_url" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"click_count" bigint DEFAULT 0 NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL
);
