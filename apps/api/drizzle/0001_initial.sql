CREATE TYPE "public"."evento_origen" AS ENUM('public', 'business', 'system');--> statement-breakpoint
CREATE TYPE "public"."evento_tipo" AS ENUM('reserva_creada', 'reserva_confirmada', 'cancelacion', 'reagendulacion', 'recordatorio_enviado', 'recordatorio_fallido', 'completado', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."recordatorio_canal" AS ENUM('email', 'log');--> statement-breakpoint
CREATE TYPE "public"."recordatorio_estado" AS ENUM('programado', 'enviado', 'fallido', 'cancelado');--> statement-breakpoint
CREATE TYPE "public"."turno_estado" AS ENUM('pendiente', 'confirmado', 'completado', 'cancelado', 'no_show');--> statement-breakpoint
CREATE TABLE "bloques_indisponibilidad" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fecha_inicio" timestamp with time zone NOT NULL,
	"fecha_fin" timestamp with time zone NOT NULL,
	"motivo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bloques_fechas_check" CHECK ("bloques_indisponibilidad"."fecha_fin" >= "bloques_indisponibilidad"."fecha_inicio")
);
--> statement-breakpoint
CREATE TABLE "clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"email" text,
	"telefono" text,
	"consentimiento" boolean NOT NULL,
	"consentido_en" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clientes_canal_check" CHECK ("clientes"."email" IS NOT NULL OR "clientes"."telefono" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "eventos_metricas" (
	"evento_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"turno_id" uuid NOT NULL,
	"cliente_id" uuid,
	"servicio_id" uuid,
	"tipo" "evento_tipo" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origen" "evento_origen" NOT NULL,
	"timestamp_utc" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "horarios_recurrentes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dia_semana" integer NOT NULL,
	"hora_inicio" time NOT NULL,
	"hora_fin" time NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "horarios_dia_check" CHECK ("horarios_recurrentes"."dia_semana" BETWEEN 1 AND 7),
	CONSTRAINT "horarios_inicio_fin_check" CHECK ("horarios_recurrentes"."hora_inicio" < "horarios_recurrentes"."hora_fin")
);
--> statement-breakpoint
CREATE TABLE "operadores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"nombre" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordatorios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"turno_id" uuid NOT NULL,
	"canal" "recordatorio_canal" NOT NULL,
	"programado_para" timestamp with time zone NOT NULL,
	"estado" "recordatorio_estado" DEFAULT 'programado' NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"ultimo_error" text,
	"enviado_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servicios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"duracion_min" integer NOT NULL,
	"precio" numeric(10, 2),
	"booking_window_days" integer DEFAULT 30 NOT NULL,
	"cancellation_grace_minutes" integer DEFAULT 180 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servicios_duracion_check" CHECK ("servicios"."duracion_min" > 0 AND "servicios"."duracion_min" % 15 = 0),
	CONSTRAINT "servicios_booking_window_check" CHECK ("servicios"."booking_window_days" BETWEEN 1 AND 90),
	CONSTRAINT "servicios_gracia_check" CHECK ("servicios"."cancellation_grace_minutes" BETWEEN 30 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "sesiones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operador_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sesiones_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"nombre" text NOT NULL,
	"timezone" text NOT NULL,
	"email_contacto" text,
	"telefono_contacto" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "turnos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"servicio_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"fecha_hora_inicio" timestamp with time zone NOT NULL,
	"fecha_hora_fin" timestamp with time zone NOT NULL,
	"estado" "turno_estado" DEFAULT 'pendiente' NOT NULL,
	"motivo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turnos_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "turnos_horario_check" CHECK ("turnos"."fecha_hora_fin" > "turnos"."fecha_hora_inicio")
);
--> statement-breakpoint
ALTER TABLE "bloques_indisponibilidad" ADD CONSTRAINT "bloques_indisponibilidad_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos_metricas" ADD CONSTRAINT "eventos_metricas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos_metricas" ADD CONSTRAINT "eventos_metricas_turno_id_turnos_id_fk" FOREIGN KEY ("turno_id") REFERENCES "public"."turnos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "horarios_recurrentes" ADD CONSTRAINT "horarios_recurrentes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operadores" ADD CONSTRAINT "operadores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordatorios" ADD CONSTRAINT "recordatorios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordatorios" ADD CONSTRAINT "recordatorios_turno_id_turnos_id_fk" FOREIGN KEY ("turno_id") REFERENCES "public"."turnos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servicios" ADD CONSTRAINT "servicios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_operador_id_operadores_id_fk" FOREIGN KEY ("operador_id") REFERENCES "public"."operadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turnos" ADD CONSTRAINT "turnos_servicio_id_servicios_id_fk" FOREIGN KEY ("servicio_id") REFERENCES "public"."servicios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clientes_tenant_email_uq" ON "clientes" USING btree (lower("email")) WHERE "clientes"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "eventos_tenant_timestamp_idx" ON "eventos_metricas" USING btree ("tenant_id","timestamp_utc");--> statement-breakpoint
CREATE INDEX "eventos_tenant_tipo_timestamp_idx" ON "eventos_metricas" USING btree ("tenant_id","tipo","timestamp_utc");--> statement-breakpoint
CREATE UNIQUE INDEX "operadores_tenant_email_uq" ON "operadores" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "recordatorios_programados_idx" ON "recordatorios" USING btree ("estado","programado_para") WHERE "recordatorios"."estado" = 'programado';--> statement-breakpoint
CREATE UNIQUE INDEX "turnos_tenant_inicio_activo_uq" ON "turnos" USING btree ("tenant_id","fecha_hora_inicio") WHERE "turnos"."estado" IN ('pendiente', 'confirmado');--> statement-breakpoint
CREATE INDEX "turnos_tenant_inicio_idx" ON "turnos" USING btree ("tenant_id","fecha_hora_inicio");--> statement-breakpoint
CREATE INDEX "turnos_tenant_estado_inicio_idx" ON "turnos" USING btree ("tenant_id","estado","fecha_hora_inicio");