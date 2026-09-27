# ~/.bash_profile for the tarubot user, copied from TaruBot's host playbook skeleton when the
# account is created (#50). Login shells read ~/.bashrc too.
if [ -f ~/.bashrc ]; then
  # shellcheck source=/dev/null
  . ~/.bashrc
fi
