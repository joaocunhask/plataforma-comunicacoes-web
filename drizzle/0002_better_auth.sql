CREATE TABLE "auth_contas" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" varchar(450) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_auth_contas_provider_account" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_sessoes" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" varchar(450) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"empresa_ativa_id" integer,
	CONSTRAINT "uq_auth_sessoes_token" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verificacoes" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AspNetUsers" ALTER COLUMN "Email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "AspNetUsers" ADD COLUMN "Image" text;--> statement-breakpoint
ALTER TABLE "AspNetUsers" ADD COLUMN "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "AspNetUsers" ADD COLUMN "UpdatedAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_contas" ADD CONSTRAINT "auth_contas_user_id_AspNetUsers_Id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."AspNetUsers"("Id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessoes" ADD CONSTRAINT "auth_sessoes_user_id_AspNetUsers_Id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."AspNetUsers"("Id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessoes" ADD CONSTRAINT "auth_sessoes_empresa_ativa_id_org_empresas_id_fk" FOREIGN KEY ("empresa_ativa_id") REFERENCES "public"."org_empresas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_auth_contas_user" ON "auth_contas" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_sessoes_user" ON "auth_sessoes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_verificacoes_identifier" ON "auth_verificacoes" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_aspnetusers_email" ON "AspNetUsers" USING btree ("Email");--> statement-breakpoint
ALTER TABLE "AspNetUsers" ADD CONSTRAINT "ck_aspnetusers_email_minusculas" CHECK ("AspNetUsers"."Email" = lower("AspNetUsers"."Email"));