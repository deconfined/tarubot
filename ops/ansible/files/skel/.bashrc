# ~/.bashrc for the tarubot user, copied from TaruBot's host playbook skeleton when the account is
# created (#50). The playbook never writes it afterwards.
#
# sshd runs the deploy key's forced command through this user's shell, and EL's bash reads this
# file for commands sent over SSH. Return at once for those non-interactive shells, before anything
# that could print or change the environment.
case $- in
  *i*) ;;
  *) return ;;
esac

# Interactive shells: the system's defaults.
if [ -f /etc/bashrc ]; then
  # shellcheck source=/dev/null
  . /etc/bashrc
fi
