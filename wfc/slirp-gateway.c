// SPDX-License-Identifier: MIT
#define _POSIX_C_SOURCE 200809L
#include <libslirp.h>
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#define FRAME_MAX 2048
#define FD_MAX 256
static struct pollfd fds[FD_MAX];
static int fd_count;

static int64_t clock_ns(void *opaque) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000000000LL + now.tv_nsec;
}
static void notify(void *opaque) {}
static void register_fd(int fd, void *opaque) {}
static void guest_error(const char *message, void *opaque) {
    fputs("WFC: invalid guest packet\n", stderr);
}
static slirp_ssize_t send_packet(const void *data, size_t length, void *opaque) {
    if (length > FRAME_MAX || length < 14) return -1;
    uint8_t packet[FRAME_MAX + 2];
    packet[0] = length >> 8;
    packet[1] = length;
    memcpy(packet + 2, data, length);
    size_t offset = 0;
    while (offset < length + 2) {
        ssize_t n = write(STDOUT_FILENO, packet + offset, length + 2 - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) exit(1);
        offset += n;
    }
    return length;
}
static int add_poll(int fd, int events, void *opaque) {
    if (fd_count == FD_MAX) exit(1);
    short mask = 0;
    if (events & SLIRP_POLL_IN) mask |= POLLIN;
    if (events & SLIRP_POLL_OUT) mask |= POLLOUT;
    if (events & SLIRP_POLL_PRI) mask |= POLLPRI;
    fds[fd_count] = (struct pollfd){ .fd = fd, .events = mask };
    return fd_count++;
}
static int get_events(int index, void *opaque) {
    short events = fds[index].revents;
    int result = 0;
    if (events & POLLIN) result |= SLIRP_POLL_IN;
    if (events & POLLOUT) result |= SLIRP_POLL_OUT;
    if (events & POLLPRI) result |= SLIRP_POLL_PRI;
    if (events & POLLERR) result |= SLIRP_POLL_ERR;
    if (events & POLLHUP) result |= SLIRP_POLL_HUP;
    return result;
}
static void limit(int resource, rlim_t value) {
    struct rlimit bound = { value, value };
    if (setrlimit(resource, &bound)) exit(1);
}
int main(void) {
    limit(RLIMIT_AS, 128 * 1024 * 1024);
    limit(RLIMIT_NOFILE, FD_MAX);
    limit(RLIMIT_CORE, 0);
    SlirpConfig config = { .version = 5, .in_enabled = true,
        .disable_host_loopback = true, .disable_dns = true,
        .if_mtu = 1500, .if_mru = 1500 };
    inet_pton(AF_INET, "10.0.2.0", &config.vnetwork);
    inet_pton(AF_INET, "255.255.255.0", &config.vnetmask);
    inet_pton(AF_INET, "10.0.2.2", &config.vhost);
    inet_pton(AF_INET, "10.0.2.15", &config.vdhcp_start);
    // DHCP and generated melonDS firmware use the same public WFC DNS.
    inet_pton(AF_INET, "178.62.43.212", &config.vnameserver);
    SlirpCb callbacks = { .send_packet = send_packet, .guest_error = guest_error,
        .clock_get_ns = clock_ns, .register_poll_fd = register_fd,
        .unregister_poll_fd = register_fd, .notify = notify };
    Slirp *slirp = slirp_new(&config, &callbacks, NULL);
    if (!slirp) return 1;
    uint8_t input[FRAME_MAX * 2 + 4];
    size_t used = 0;
    for (;;) {
        fd_count = 1;
        fds[0] = (struct pollfd){ .fd = STDIN_FILENO, .events = POLLIN };
        uint32_t timeout = 50;
        slirp_pollfds_fill(slirp, &timeout, add_poll, NULL);
        int result = poll(fds, fd_count, timeout);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0) break;
        slirp_pollfds_poll(slirp, false, get_events, NULL);
        if (fds[0].revents & POLLIN) {
            ssize_t count = read(STDIN_FILENO, input + used, sizeof(input) - used);
            if (count <= 0) break;
            used += count;
            size_t offset = 0;
            while (used - offset >= 2) {
                size_t length = (input[offset] << 8) | input[offset + 1];
                if (length < 14 || length > FRAME_MAX) return 1;
                if (used - offset < length + 2) break;
                slirp_input(slirp, input + offset + 2, length);
                offset += length + 2;
            }
            memmove(input, input + offset, used - offset);
            used -= offset;
        } else if (fds[0].revents & (POLLHUP | POLLERR)) break;
    }
    slirp_cleanup(slirp);
    return 0;
}
