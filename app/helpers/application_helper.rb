module ApplicationHelper

    def can_edit(list)
      current_user && current_user.id == list.user
    end

    def user_authenticated?
      current_user.try(:authenticated?)
    end

    def button_text_for_user_auth
      if current_user
        "Save this list with my Google account"
      else
        "Login with Google to edit this list"
      end
    end
end
