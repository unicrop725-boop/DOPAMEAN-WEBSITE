CREATE TYPE "public"."reservation_status" AS ENUM('held', 'committed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('unfulfilled', 'shipped', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."order_payment_method" AS ENUM('online', 'cod');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'confirmed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('created', 'captured', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('online', 'cod');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'captured', 'failed', 'partially_refunded', 'refunded', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "store_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "reservation_qty_pos" CHECK ("reservation"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "cart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text,
	"anon_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_has_owner" CHECK ("cart"."customer_id" IS NOT NULL OR "cart"."anon_token_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "cart_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_line_qty_range" CHECK ("cart_line"."qty" > 0 AND "cart_line"."qty" <= 10)
);
--> statement-breakpoint
CREATE TABLE "order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1),
	"customer_id" text,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"fulfillment_status" "fulfillment_status" DEFAULT 'unfulfilled' NOT NULL,
	"payment_method" "order_payment_method" NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"shipping_paise" bigint NOT NULL,
	"cod_fee_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"shipping_address" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"access_token_hash" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_deadline_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "order_total_nonneg" CHECK ("order"."total_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"option_label" text NOT NULL,
	"option_values" jsonb NOT NULL,
	"sku" text NOT NULL,
	"image_key" text,
	"hsn_code" text,
	"unit_paise" bigint NOT NULL,
	"qty" integer NOT NULL,
	"discount_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"tax_rate_bp" integer NOT NULL,
	"tax_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	CONSTRAINT "order_line_qty_pos" CHECK ("order_line"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount_paise" bigint NOT NULL,
	"captured_paise" bigint DEFAULT 0 NOT NULL,
	"refunded_paise" bigint DEFAULT 0 NOT NULL,
	"provider" text,
	"provider_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunded_le_captured" CHECK ("payment"."refunded_paise" <= "payment"."captured_paise"),
	CONSTRAINT "payment_captured_le_amount" CHECK ("payment"."captured_paise" <= "payment"."amount_paise"),
	CONSTRAINT "payment_amounts_nonneg" CHECK ("payment"."captured_paise" >= 0 AND "payment"."refunded_paise" >= 0 AND "payment"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_order_id" text NOT NULL,
	"provider_payment_id" text,
	"status" "payment_attempt_status" DEFAULT 'created' NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_refund_id" text,
	"reason" text,
	"created_by" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_amount_pos" CHECK ("refund"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"raw_body" text NOT NULL,
	"signature_ok" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "shipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"carrier" text NOT NULL,
	"tracking_no" text NOT NULL,
	"tracking_url" text,
	"shipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "cart_line" ADD CONSTRAINT "cart_line_cart_id_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."cart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservation_due_idx" ON "reservation" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "reservation_ref_idx" ON "reservation" USING btree ("ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_customer_uq" ON "cart" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_anon_uq" ON "cart" USING btree ("anon_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_line_variant_uq" ON "cart_line" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE INDEX "cart_line_cart_idx" ON "cart_line" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_public_id_uq" ON "order" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_number_uq" ON "order" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "order_idempotency_uq" ON "order" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "order_customer_idx" ON "order" USING btree ("customer_id","placed_at");--> statement-breakpoint
CREATE INDEX "order_status_idx" ON "order" USING btree ("status","placed_at");--> statement-breakpoint
CREATE INDEX "order_event_order_idx" ON "order_event" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "order_line_order_idx" ON "order_line" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_uq" ON "payment" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_order_uq" ON "payment" USING btree ("provider_order_id");--> statement-breakpoint
CREATE INDEX "payment_attempt_payment_idx" ON "payment_attempt" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_attempt_status_idx" ON "payment_attempt" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_idempotency_uq" ON "refund" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "refund_payment_idx" ON "refund" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_provider_event_uq" ON "webhook_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "shipment_order_idx" ON "shipment" USING btree ("order_id");