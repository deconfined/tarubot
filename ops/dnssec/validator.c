/*
 * Bounded libunbound bridge. Only locally validated wire RDATA leaves this process; resolver
 * diagnostics, AD flags and remote resolver configuration never become evidence. The build
 * statically links the authenticated libunbound source, and pins its private crypto/loader closure.
 */
#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <openssl/crypto.h>
#include <unbound.h>

#define MAX_RECORDS 32
#define MAX_RDATA 66
#define EXPECTED_VERSION "1.26.1"

static int valid_name(const char *name) {
  size_t n = strlen(name), label = 0;
  int dots = 0;
  if (n < 3 || n > 253) return 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)name[i];
    if (c == '.') {
      if (label == 0 || label > 63 || name[i - 1] == '-') return 0;
      label = 0;
      dots++;
    } else {
      if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'))
        return 0;
      if (label == 0 && c == '-') return 0;
      label++;
    }
  }
  return dots > 0 && label > 0 && label <= 63 && name[n - 1] != '-';
}

static int64_t milliseconds(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static int answer_valid(const struct ub_result *r, int type, const char *name) {
  if (!r || !r->qname || strcmp(r->qname, name) != 0 || r->qtype != type ||
      r->qclass != 1 || r->secure != 1 || r->bogus || !r->havedata ||
      r->nxdomain || r->rcode || r->was_ratelimited || r->canonname ||
      r->ttl <= 0 || r->ttl > 86400 || !r->data || !r->len)
    return 0;
  size_t count = 0;
  for (; count <= MAX_RECORDS && r->data[count]; count++) {
    int size = r->len[count];
    if ((type == 1 && size != 4) || (type == 28 && size != 16) ||
        (type == 44 && (size < 3 || size > MAX_RDATA))) return 0;
  }
  return count > 0 && count <= MAX_RECORDS;
}

static int option(struct ub_ctx *ctx, const char *key, const char *value) {
  return ub_ctx_set_option(ctx, key, value) == 0;
}

int main(int argc, char **argv) {
  struct ub_ctx *ctx = NULL;
  struct ub_result *answers[3] = {NULL, NULL, NULL};
  const int types[3] = {44, 1, 28};
  int result = 1;
  int64_t started = milliseconds(), elapsed;
  /* SIGALRM terminates a stalled lookup without publishing partial JSON. Parent also bounds it. */
  alarm(20);
  if (argc != 3 || !valid_name(argv[2]) || started < 0 ||
      strcmp(ub_version(), EXPECTED_VERSION) != 0) goto done;
  /* No openssl.cnf, provider/module environment or inherited crypto configuration is loaded. */
  if (!OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG, NULL)) goto done;
  ctx = ub_ctx_create();
  if (!ctx || ub_ctx_debugout(ctx, NULL) != 0 || ub_ctx_debuglevel(ctx, 0) != 0 ||
      ub_ctx_set_fwd(ctx, NULL) != 0 ||
      !option(ctx, "module-config:", "validator iterator") ||
      !option(ctx, "val-permissive-mode:", "no") ||
      !option(ctx, "harden-dnssec-stripped:", "yes") ||
      !option(ctx, "harden-algo-downgrade:", "yes") ||
      !option(ctx, "serve-expired:", "no") ||
      !option(ctx, "prefetch:", "no") ||
      !option(ctx, "prefetch-key:", "no") ||
      !option(ctx, "use-syslog:", "no") ||
      !option(ctx, "log-queries:", "no") ||
      !option(ctx, "log-replies:", "no") ||
      ub_ctx_add_ta_file(ctx, argv[1]) != 0) goto done;
#ifdef TARUBOT_DNSSEC_LAB
  /* Compile-only fixed fixture root: this measured binary is never a production artifact. */
  if (ub_ctx_set_stub(ctx, ".", "127.0.0.1@15353", 0) != 0 ||
      !option(ctx, "do-not-query-localhost:", "no") ||
      !option(ctx, "do-ip6:", "no") ||
      /* Flat synthetic root has no real delegation tree; avoid minimisation's address cache
       * while exercising direct signed RRsets. The production iterator keeps its defaults. */
      !option(ctx, "qname-minimisation:", "no") ||
      !option(ctx, "outgoing-interface:", "127.0.0.1")) goto done;
#endif
  /* Never call ub_ctx_config/resolvconf/hosts or add insecure domains or a forwarder. */
  for (size_t i = 0; i < 3; i++) {
    if (ub_resolve(ctx, argv[2], types[i], 1, &answers[i]) != 0 ||
        !answer_valid(answers[i], types[i], argv[2])) goto done;
  }
  elapsed = milliseconds() - started;
  if (elapsed < 0 || elapsed >= 20000) goto done;
  /* Name is validated ASCII; all remaining variable output is numeric or hex wire bytes. */
  printf("{\"schema\":1,\"version\":\"%s\",\"mode\":\"local-validating\","
         "\"name\":\"%s\",\"elapsed_ms\":%lld,\"answers\":[",
         EXPECTED_VERSION, argv[2], (long long)elapsed);
  for (size_t i = 0; i < 3; i++) {
    struct ub_result *r = answers[i];
    printf("%s{\"type\":%d,\"class\":1,\"secure\":true,\"bogus\":false,"
           "\"havedata\":true,\"nxdomain\":false,\"rcode\":0,\"ttl\":%d,\"rdata\":[",
           i ? "," : "", types[i], r->ttl);
    for (size_t j = 0; r->data[j]; j++) {
      printf("%s\"", j ? "," : "");
      for (int k = 0; k < r->len[j]; k++) printf("%02x", (unsigned char)r->data[j][k]);
      printf("\"");
    }
    printf("]}");
  }
  printf("]}\n");
  if (fflush(stdout) == 0 && !ferror(stdout)) result = 0;
done:
  for (size_t i = 0; i < 3; i++) if (answers[i]) ub_resolve_free(answers[i]);
  if (ctx) ub_ctx_delete(ctx);
  if (result) fputs("invalid-local-dnssec\n", stderr);
  return result;
}
