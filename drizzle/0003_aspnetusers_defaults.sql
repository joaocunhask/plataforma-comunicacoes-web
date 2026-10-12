ALTER TABLE "AspNetUsers" ALTER COLUMN "PhoneNumberConfirmed" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "AspNetUsers" ALTER COLUMN "TwoFactorEnabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "AspNetUsers" ALTER COLUMN "LockoutEnabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "AspNetUsers" ALTER COLUMN "AccessFailedCount" SET DEFAULT 0;